import type { Request, RequestHandler, Response, Router } from 'express';
import type mongoose from 'mongoose';
import type { OutputType } from './tsGenerator.js';
import type { Accesses, AccessType, FieldType, FileMiddlewareFunction, FilterObject, GuardResults, MaybePromise, MiddlewareAfterFunction, MiddlewareBeforeFunction, MiddlewareTiming, Model, MongooseDocument, OperationType, RoboField, RoboFile, SortObject, SortValue, WithAccessGroups } from './types.js';
export type * from './types.js';
interface RobogoConfig<Namespace extends string, AccessGroup extends string> {
    /** The mongoose connection instance */
    mongooseConnection: mongoose.Connection;
    /** Glob pattern to the schema files (eg.: './schemas/*.ts')  */
    schemaPathGlob: string;
    /** Glob pattern to the service files (eg.: './services/*.ts')  */
    servicePathGlob?: string | null;
    /** Absolute path to the directory in which robogo should store the uploaded files */
    fileDir?: string | null;
    /** The time in milliseconds until if the same file is requested another time, it can be served from the cache memory */
    maxFileCacheAge?: number;
    /** Uploaded images higher or wider than this number will be resized to this size */
    maxImageSize?: number;
    /** Indicates whether robogo should create a small sized version of the images that are uploaded or not */
    createThumbnail?: boolean;
    /** If createThumbnail is true, it behaves the same way as maxImageSize but for thumbnail images. */
    maxThumbnailSize?: number;
    /** Middleware function to controll file access, if it rejects, the request will be canceled */
    fileReadMiddleware?: FileMiddlewareFunction | null;
    /** Middleware function to controll file uploads, if it rejects, the request will be canceled */
    fileUploadMiddleware?: FileMiddlewareFunction | null;
    /** Middleware function to controll file deletes, if it rejects, the request will be canceled */
    fileDeleteMiddleware?: FileMiddlewareFunction | null;
    /** Indicates whether access checking should be enabled in Robogo */
    checkAccess?: boolean;
    /** List of access group namespaces */
    namespaces?: readonly Namespace[];
    /** Either a list of access groups, or if namspaces are used, then an object with acces groups as keys and a list of namespaces as values. */
    accessGroups?: readonly AccessGroup[] | Record<AccessGroup, readonly Namespace[]>;
    /** Either a list of access groups to be used as admin groups, or if namspaces are used, then an object with namespaces as keys and a list of access groups as values. */
    adminGroups?: null | AccessGroup[] | Partial<Record<Namespace, readonly AccessGroup[]>>;
    /** Whether to log error messages */
    showErrors?: boolean;
    /** Whether to log warning messages */
    showWarnings?: boolean;
    /** Whether to log info messages */
    showLogs?: boolean;
}
export default interface Robogo<Namespace extends string, AccessGroup extends string> extends Required<Omit<RobogoConfig<Namespace, AccessGroup>, 'accessGroups' | 'showErrors' | 'showWarnings' | 'showLogs'>> {
}
export default class Robogo<Namespace extends string = string, AccessGroup extends string = string> {
    models: Record<string, Model<Namespace, AccessGroup>>;
    /** A tree like structure of the fields of the models */
    schemas: Record<string, RoboField<AccessGroup>[]>;
    /** A flattened structure of the fields of the models, where the paths of the fields is used as key */
    pathSchemas: Record<string, Record<string, RoboField<AccessGroup>>>;
    /** The same structure as 'this.schemas', but with ref cycles removed  */
    decycledSchemas: Record<string, RoboField<AccessGroup>[]>;
    accessGroups: Record<AccessGroup, readonly Namespace[]>;
    operations: OperationType[];
    timings: MiddlewareTiming[];
    accessTypes: readonly ["read", "write"];
    groupTypes: {
        readonly read: "readGroups";
        readonly write: "writeGroups";
    };
    guardTypes: {
        readonly read: "readGuards";
        readonly write: "writeGuards";
    };
    /** The fields of the RoboFile model */
    private roboFileShema;
    private services;
    private middlewares;
    private logger;
    private upload;
    constructor({ mongooseConnection, schemaPathGlob, servicePathGlob, fileDir, maxFileCacheAge, maxImageSize, createThumbnail, maxThumbnailSize, fileReadMiddleware, fileUploadMiddleware, fileDeleteMiddleware, checkAccess, namespaces, accessGroups, adminGroups, showErrors, showWarnings, showLogs, }: RobogoConfig<Namespace, AccessGroup>);
    registerRoboFileModel(): void;
    init(): Promise<void>;
    /**
     * Imports every model from "SchemaDir" and creates a robogo schema for it.
     * Also creates default middlewares for them.
     * Finally it handles the references between the schemas.
     */
    processSchemas(): Promise<void>;
    /** Constructs a robogo model instance from a mongoose model instance */
    generateModel(mongooseModel: mongoose.Model<unknown>): Model<Namespace, AccessGroup>;
    /** Handles adding read and write groups to a model, from its mongoose instance and the global admin groups */
    addAccessGroupsToModel(mongooseModel: mongoose.Model<unknown>, roboModel: Model<Namespace, AccessGroup>): void;
    /** Add the admin groups to the target's access groups */
    addAdminGroups(target: WithAccessGroups<AccessGroup>, model: Model<Namespace, AccessGroup>): void;
    /** We check if there are unknown access groups in 'source', and if so, we warn the user */
    validateGroups(source: WithAccessGroups<AccessGroup>, model: Model<Namespace, AccessGroup>): void;
    /** Constructs a sort object from the possible sort types (https://mongoosejs.com/docs/api/query.html#Query.prototype.sort()) */
    convertToSortObject(sortValue: SortValue): SortObject;
    /** Generates a robogo schema instance from a mongoose model instance. */
    generateSchema(model: Model<Namespace, AccessGroup>): RoboField<AccessGroup>[];
    /** Generates a RoboField instance from a mongoose SchemaType */
    generateRoboField(model: Model<Namespace, AccessGroup>, schema: mongoose.Schema, type: mongoose.SchemaType): RoboField<AccessGroup>;
    /** Extrancts and translates the mongoose schema type to a robogo type format */
    getRoboTypeFromSchemaType(type: mongoose.SchemaType): FieldType;
    addEmbeddedProperties(model: Model<Namespace, AccessGroup>, schema: mongoose.Schema, roboField: RoboField<AccessGroup>): void;
    plugInFieldRef(field: RoboField<AccessGroup>, modelName: string): void;
    /** Creates a copy of the schemas with circular references removed from them */
    generateDecycledSchemas(): void;
    /** Checks if 'field' is referencing a model, which was already referenced earlier in the tree and if so it removes the subfields */
    decycleField(field: RoboField<AccessGroup>, visitedRefs?: string[]): RoboField<AccessGroup>;
    /** Creates a flat representation for the schemas, in which fields can be accessed with a '.' separated path */
    generatePathSchemas(): void;
    /** Recursively adds a field and its subfields to this.decycledSchemas[modelName] */
    generatePathSchema(modelName: string, field: RoboField<AccessGroup>, prefix?: string): void;
    /** Calculates the smallest sets of access groups for every model which are enough to read/write every field in them */
    collectMinimalRequiredAccessesGroupSetsOfModels(): void;
    /** Calculates the smallest sets of access groups to be able to read/write a field and its subfields. */
    collectMinimalRequiredAccessGroupSets(field: Pick<RoboField<AccessGroup>, 'subfields' | 'readGroups' | 'writeGroups' | 'ref'>): Record<AccessType, AccessGroup[][]>;
    /** Merges the access group combinations in "sourceCombinationsArray" with "targetCombinations" into new minimal access group combinations */
    mergeAccessGroupCombinations(targetCombinations: AccessGroup[][], sourceCombinationsArray: AccessGroup[][][]): AccessGroup[][];
    wrapExpressMiddleware(middleware: FileMiddlewareFunction | null): RequestHandler;
    /**
     * Helper function, that is used when an image was uploaded.
     * It will resize the image to the specified size if needed.
     * It will create a RoboFile document for the image, with the properties of the image.
     * It will also create a thumbnail of the image if needed.
     */
    handleImageUpload(file: Express.Multer.File): Promise<mongoose.Document<unknown, {}, RoboFile> & RoboFile & Required<{
        _id: mongoose.Types.ObjectId;
    }> & {
        __v?: number;
    }>;
    /**
     * Resizes an image at the sourcePath to the given size and saves it to the destinationPath.
     * @param {string} sourcePath
     * @param {number} size
     * @param {string} destinationPath
     */
    resizeImageTo(sourcePath: string, size: number, destinationPath: string): Promise<number | undefined>;
    handleFileUpload(file: Express.Multer.File): Promise<mongoose.Document<unknown, {}, RoboFile> & RoboFile & Required<{
        _id: mongoose.Types.ObjectId;
    }> & {
        __v?: number;
    }>;
    /** A helper function, that is a template for the CRUDS category routes. */
    CRUDSRoute<T>({ req, res, operation, mainPart, responsePart }: {
        req: Request;
        res: Response;
        operation: OperationType;
        mainPart: () => Promise<T>;
        responsePart: (result: T) => Promise<void>;
    }): Promise<Response<any, Record<string, any>> | undefined>;
    hasModelAccess(modelName: string, mode: AccessType, req: Request): Promise<boolean>;
    /** Checks if the two given arrays have an intersection or not. */
    hasGroupAccess(goodGroups: undefined | AccessGroup[], accessGroups: AccessGroup[]): boolean;
    /** Removes declined fields from an object. */
    removeDeclinedFieldsFromObject({ object, mode, req, guardResults, ...params }: {
        object: Partial<MongooseDocument> | null;
        mode: AccessType;
        req: Request;
        guardResults?: GuardResults;
    } & ({
        fields: RoboField<AccessGroup>[];
    } | {
        modelName: string;
    })): Promise<void>;
    removeDeclinedFieldsFromObjectHelper({ object, req, field, mode, checkGroupAccess, guardResults }: {
        object: Partial<MongooseDocument>;
        mode: AccessType;
        req: Request;
        guardResults: GuardResults;
        checkGroupAccess: boolean;
        field: RoboField<AccessGroup>;
    }): Promise<void>;
    /** Checks if there is minimal required access groups set for the model, of which every group is in the requests access groups */
    hasEveryNeededAccessGroup(modelName: string, mode: AccessType, accessGroups: AccessGroup[]): boolean;
    /** Calculates a Map of every access guard function and their results, that appear on the given fields */
    calculateGuardResults({ req, fields, mode, calculatedGuardResults }: {
        req: Request;
        fields: RoboField<AccessGroup>[];
        mode: AccessType;
        calculatedGuardResults?: GuardResults;
    }): Promise<GuardResults>;
    /** Checks if the given field is readable/writeable with the request */
    isFieldDeclined({ req, field, mode, checkGroupAccess, guardResults }: {
        req: Request;
        field: RoboField<AccessGroup>;
        mode: AccessType;
        checkGroupAccess?: boolean;
        guardResults?: null | GuardResults;
    }): Promise<boolean>;
    /** Checks if the field is declined by the guard functions defined on it. */
    isFieldDecliendByGuards(req: Request, field: RoboField<AccessGroup>, mode: AccessType, guardResults?: null | GuardResults): Promise<boolean>;
    /** Removes every field that are not readable/writeable with the provided request in every document. */
    removeDeclinedFields({ documents, mode, req, ...params }: {
        documents: MongooseDocument[];
        mode: AccessType;
        req: Request;
    } & ({
        fields: RoboField<AccessGroup>[];
    } | {
        modelName: string;
    })): Promise<void>;
    processFilter(req: Request): Promise<FilterObject>;
    /** Extends the given filter object with the given models default filters (if any) */
    extendFilterWithDefaults(modelName: string, filter: FilterObject): Promise<FilterObject>;
    /** Removes the fields from a filter which can't be read/written with the provided request */
    removeDeclinedFieldsFromFilter(req: Request, filter: FilterObject): Promise<FilterObject>;
    /** Visits every condition and group in a filter object. It can also be used to construct a new filter object. */
    visitFilter({ filter, groupVisitor, conditionVisitor }: {
        filter: FilterObject;
        conditionVisitor?: (path: string, value: unknown) => MaybePromise<unknown>;
        groupVisitor?: (conditions: FilterObject[]) => MaybePromise<FilterObject[]>;
    }): Promise<FilterObject>;
    /** Adds the default sorts to the requests sort param (if any) and removes those fields from the sort object, that are not readable by the provided request */
    processSort(req: Request): Promise<{
        [x: string]: mongoose.SortOrder | {
            $meta: any;
        };
    }>;
    getAccesses(modelName: string, req: Request): Promise<Accesses>;
    addFieldAccesses({ mode, field, req, checkGroupAccess, guardResults, accesses, prefix }: {
        accesses: Record<string, Partial<Record<AccessType, boolean>>>;
        mode: AccessType;
        field: RoboField<AccessGroup>;
        req: Request;
        checkGroupAccess: boolean;
        guardResults: GuardResults;
        prefix?: string;
    }): Promise<void>;
    serviceRoute(req: Request, res: Response, paramsKey: 'body' | 'query'): Response<any, Record<string, any>> | undefined;
    /** Removes every fields that cannot be read/written by the provided request. The fields parameter should always be a 'decycledSchema'. */
    removeDeclinedFieldsFromSchema({ fields, req, mode, modelName, guardResults }: {
        fields: RoboField<AccessGroup>[];
        mode: AccessType;
        req: Request;
        modelName?: string;
        guardResults?: GuardResults;
    }): Promise<RoboField<AccessGroup>[]>;
    /** Generates all the routes of robogo and returns the express router. */
    generateRoutes(): Router;
    addMiddleware(modelName: string, operation: OperationType, timing: 'before', middlewareFunction: MiddlewareBeforeFunction): void;
    addMiddleware(modelName: string, operation: OperationType, timing: 'after', middlewareFunction: MiddlewareAfterFunction): void;
    generateTSDefintions({ type, output }: {
        type: OutputType;
        output: string;
    }): Promise<void>;
}
