import type { RoboField } from './types'

export type OutputType = 'frontend' | 'backend'

export class TSGenerator<AccessGroup extends string> {
  constructor(private schemas: Record<string, RoboField<AccessGroup>[]>, private type: OutputType) {
  }

  generate() {
    const fileParts: string[] = []

    if (this.type === 'backend')
      fileParts.push(`import type mongoose from 'mongoose'`)

    const definitions = Object.entries(this.schemas)
      .map(([modelName, schema]) => this.generateTSDefinitionForSchema(modelName, schema))
      .join('\n\n')

    fileParts.push(definitions)

    return fileParts.join('\n\n')
  }

  private generateTSDefinitionForSchema(modelName: string, schema: RoboField<AccessGroup>[]): string {
    const fields = this.generateTSDefinitionForObject(schema, 1)
    return `interface ${modelName} ${fields}`
  }

  private generateTSDefinitionForObject(fields: RoboField<AccessGroup>[], depth: number): string {
    const lines = ['{']

    if (depth === 1) {
      if (this.type === 'frontend')
        lines.push(`${getIndentation(depth)}_id: string`)
      else
        lines.push(`${getIndentation(depth)}_id: mongoose.Types.ObjectId`)
    }

    for (const field of fields) {
      const type = this.getTSType(field, depth)
      const optional = !field.required ? '?' : ''
      const indentation = getIndentation(depth)
      lines.push(`${indentation}${field.key}${optional}: ${type}`)
    }

    const indentation = getIndentation(depth - 1)
    lines.push(`${indentation}}`)

    return lines.join('\n')
  }

  private getTSType(field: RoboField<AccessGroup>, depth: number, arrayItem = false): string {
    if (field.isArray && !arrayItem)
      return `Array<${this.getTSType(field, depth, true)}>`

    switch (field.type) {
      case 'String': return 'string'
      case 'Boolean': return 'boolean'
      case 'Date': return 'Date'
      case 'Number': return 'number'
      case 'Object': {
        if (field.ref)
          return `${field.ref}`
        else
          return this.generateTSDefinitionForObject(field.subfields!, depth + 1)
      }
    }

    throw new Error(`Robogo Error: Encountered unknown type '${field.type}' while generating typescript definitions.`)
  }
}

function getIndentation(depth: number) {
  return '  '.repeat(depth)
}
