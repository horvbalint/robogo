import type { RoboField } from '../types';
export declare class TSGenerator<AccessGroup extends string> {
    interfaces: string[];
    constructor(schemas: Record<string, RoboField<AccessGroup>[]>);
    get definitions(): string;
    private generateTSDefinitionForSchema;
    private generateTSDefinitionForObject;
    private getTSType;
}
