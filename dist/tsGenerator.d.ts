import type { RoboField } from './types';
export type OutputType = 'frontend' | 'backend';
export declare class TSGenerator<AccessGroup extends string> {
    private schemas;
    private type;
    constructor(schemas: Record<string, RoboField<AccessGroup>[]>, type: OutputType);
    generate(): string;
    private generateTSDefinitionForSchema;
    private generateTSDefinitionForObject;
    private getTSType;
}
