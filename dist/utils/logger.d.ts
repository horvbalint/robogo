import type { MiddlewareTiming } from '../types.js';
interface ConstructorParams {
    showErrors: boolean;
    showWarnings: boolean;
    showLogs: boolean;
}
export default class Logger {
    private showErrors;
    private showWarnings;
    private showLogs;
    constructor({ showErrors, showWarnings, showLogs }: ConstructorParams);
    /**
     * @param {'error' | 'warning' | 'log'} type
     * @param {string} occurrence
     * @param {string} title
     * @param {string} description
     */
    logMessage(type: string, occurrence: string, title: string, description: string): void;
    logUnknownReference(modelName: string, fieldKey: string, referencedModel: string, occurrence: string): void;
    logIncorrectAdminGroups(adminGroups: unknown, occurrence: string): void;
    logMissingModel(modelName: string, occurrence: string): void;
    logMissingService(serviceName: string, occurrence: string): void;
    logMissingServiceFunction(serviceName: string, functionName: string, occurrence: string): void;
    logUnknownOperation(operation: string, occurrence: string): void;
    logUnknownTiming(timing: MiddlewareTiming, occurrence: string): void;
    logMiddlewareMessage(modelName: string, operation: string, timing: MiddlewareTiming, message: string): void;
    logUnknownAccessGroupInField(modelName: string, fieldKey: string, accessGroup: string, occurrence: string): void;
    logUnknownAccessGroupInModel(modelName: string, accessGroup: string, occurrence: string): void;
    logIncorrectAccessGroupNamespaceInField(modelName: string, fieldKey: string, accessGroup: string, accessGroupNamespaces: readonly string[], modelNamespaces: readonly string[], occurrence: string): void;
    logIncorrectAccessGroupNamespaceInModel(modelName: string, accessGroup: string, accessGroupNamespaces: readonly string[], modelNamespaces: readonly string[], occurrence: string): void;
    logUnknownNamespaceInModel(modelName: string, namespace: string, occurrence: string): void;
    logUnknownNamespaceInAccessGroup(accessGroup: string, namespace: string, occurrence: string): void;
}
export {};
