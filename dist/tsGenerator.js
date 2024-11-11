export class TSGenerator {
    schemas;
    type;
    constructor(schemas, type) {
        this.schemas = schemas;
        this.type = type;
    }
    generate() {
        const fileParts = [];
        if (this.type === 'backend')
            fileParts.push(`import type mongoose from 'mongoose'`);
        const definitions = Object.entries(this.schemas)
            .map(([modelName, schema]) => this.generateTSDefinitionForSchema(modelName, schema))
            .join('\n\n');
        fileParts.push(definitions);
        return fileParts.join('\n\n');
    }
    generateTSDefinitionForSchema(modelName, schema) {
        const fields = this.generateTSDefinitionForObject(schema, 1);
        return `export type ${modelName} = ${fields}`;
    }
    generateTSDefinitionForObject(fields, depth) {
        const lines = ['{'];
        const optional = depth > 1 ? '?' : '';
        if (this.type === 'frontend')
            lines.push(`${getIndentation(depth)}_id${optional}: string`);
        else
            lines.push(`${getIndentation(depth)}_id${optional}: mongoose.Types.ObjectId`);
        for (const field of fields) {
            const type = this.getTSType(field, depth);
            const optional = !field.required ? '?' : '';
            const indentation = getIndentation(depth);
            lines.push(`${indentation}${field.key}${optional}: ${type}`);
        }
        const indentation = getIndentation(depth - 1);
        lines.push(`${indentation}}`);
        return lines.join('\n');
    }
    getTSType(field, depth, arrayItem = false) {
        if (field.isArray && !arrayItem)
            return `Array<${this.getTSType(field, depth, true)}>`;
        switch (field.type) {
            case 'String': return 'string';
            case 'Boolean': return 'boolean';
            case 'Date': return 'Date | string';
            case 'Number': return 'number';
            case 'Object': {
                if (field.ref) {
                    if (field.autopopulate && (field.autopopulate === true || field.autopopulate?.maxDepth !== 0))
                        return `${field.ref}`;
                    else
                        return `${field.ref}['_id']`;
                }
                else {
                    return this.generateTSDefinitionForObject(field.subfields, depth + 1);
                }
            }
        }
        throw new Error(`Robogo Error: Encountered unknown type '${field.type}' while generating typescript definitions.`);
    }
}
function getIndentation(depth) {
    return '  '.repeat(depth);
}
