export class TSGenerator {
    interfaces = [];
    constructor(schemas) {
        for (const schema in schemas)
            this.generateTSDefinitionForSchema(schema, schemas[schema]);
    }
    get definitions() {
        return this.interfaces.join('\n\n');
    }
    generateTSDefinitionForSchema(modelName, schema) {
        const fields = this.generateTSDefinitionForObject(modelName, schema, 1);
        this.interfaces.push(`interface ${modelName} ${fields}`);
    }
    generateTSDefinitionForObject(modelName, fields, depth) {
        const lines = ['{'];
        for (const field of fields) {
            const type = this.getTSType(modelName, field, depth);
            const optional = !field.required ? '?' : '';
            const indentation = getIndentation(depth);
            lines.push(`${indentation}${field.key}${optional}: ${type}`);
        }
        const indentation = getIndentation(depth - 1);
        lines.push(`${indentation}}`);
        return lines.join('\n');
    }
    getTSType(modelName, field, depth, arrayItem = false) {
        if (field.isArray && !arrayItem)
            return `Array<${this.getTSType(modelName, field, depth, true)}>`;
        switch (field.type) {
            case 'String': return 'string';
            case 'Boolean': return 'boolean';
            case 'Date': return 'Date';
            case 'Number': return 'number';
            case 'Object': {
                if (field.ref) {
                    return `${field.ref}`;
                }
                else {
                    const subInterfaceName = modelName + field.key;
                    this.generateTSDefinitionForSchema(subInterfaceName, field.subfields);
                    return subInterfaceName;
                }
            }
        }
        throw new Error(`Robogo Error: Encountered unknown type '${field.type}' while generating typescript definitions.`);
    }
}
function getIndentation(depth) {
    return '  '.repeat(depth);
}
