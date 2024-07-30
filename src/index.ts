import path from 'node:path'
import fs from 'node:fs'
import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import Fuse from 'fuse.js'
import type mongoose from 'mongoose'
import type { Request, Response } from 'express'
import { glob } from 'glob'
import RoboFileModel from './schemas/roboFile'
import Logger from './utils/logger'
import MinimalSetCollection from './utils/minimalSetCollection'
import type { AccessType, FileMiddlewareFunction, FilterObject, GuardFunction, GuardPreCache, MaybePromise, MiddlewareAfterFunction, MiddlewareBeforeFunction, MiddlewareTiming, Model, MongooseDocument, NestedArray, OperationType, RoboField, ServiceFunction, SortObject, SortValue, WithAccessGroups } from './types'
import { model, mongo, Mongoose, ObjectId } from 'mongoose'

const Router = express.Router()

class MiddlewareError extends Error {
  constructor(public type: MiddlewareTiming, err: Error) {
    super(type, { cause: err })
  }
}

interface RobogoConfig<Namespace extends string, AccessGroup extends string> {
  /** The mongoose connection instance */
  mongooseConnection: mongoose.Connection
  /** Path to the directory in which the mongoose models are defined and exported */
  schemaDir: string
  /** Path to the directory in which the robogo services are defined and exported */
  serviceDir?: string | null
  /** Path to the directory in which robogo should store the uploaded files */
  fileDir?: string | null
  /** The time in milliseconds until if the same file is requested another time, it can be served from the cache memory */
  maxFileCacheAge?: number
  /** Uploaded images higher or wider than this number will be resized to this size */
  maxImageSize?: number
  /** Indicates whether robogo should create a small sized version of the images that are uploaded or not */
  createThumbnail?: boolean
  /** If createThumbnail is true, it behaves the same way as maxImageSize but for thumbnail images. */
  maxThumbnailSize?: number
  /** Middleware function to controll file access, if it rejects, the request will be canceled */
  fileReadMiddleware?: FileMiddlewareFunction | null
  /** Middleware function to controll file uploads, if it rejects, the request will be canceled */
  fileUploadMiddleware?: FileMiddlewareFunction | null
  /** Middleware function to controll file deletes, if it rejects, the request will be canceled */
  fileDeleteMiddleware?: FileMiddlewareFunction | null
  /** Indicates whether access checking should be enabled in Robogo */
  checkAccess?: boolean
  /** List of access group namespaces */
  namespaces?: readonly Namespace[]
  /** Either a list of access groups, or if namspaces are used, then an object with acces groups as keys and a list of namespaces as values. */
  accessGroups?: readonly AccessGroup[] | Record<AccessGroup, readonly Namespace[]>
  /** Either a list of access groups to be used as admin groups, or if namspaces are used, then an object with namespaces as keys and a list of access groups as values. */
  adminGroups?: null | AccessGroup[] | Partial<Record<Namespace, readonly AccessGroup[]>>
  /** Whether to log error messages */
  showErrors?: boolean
  /** Whether to log warning messages */
  showWarnings?: boolean
  /** Whether to log info messages */
  showLogs?: boolean
}

// This is a trick, so we don't have to define all properties twice, in the class as well. See: https://stackoverflow.com/questions/43838202/destructured-parameter-properties-in-constructor
export default interface Robogo<Namespace extends string, AccessGroup extends string>
  extends Required<
    Omit<
      RobogoConfig<Namespace, AccessGroup>,
      'accessGroups' | 'showErrors' | 'showWarnings' | 'showLogs'
    >
  > {}

// eslint-disable-next-line ts/no-unsafe-declaration-merging
export default class Robogo<Namespace extends string, AccessGroup extends string> {
  public models: Record<string, Model<Namespace, AccessGroup>> = {}
  /** A tree like structure of the fields of the models */
  public schemas: Record<string, RoboField<AccessGroup>[]> = {}
  /** A flattened structure of the fields of the models, where the paths of the fields is used as key */
  public pathSchemas: Record<string, Record<string, RoboField<AccessGroup>>> = {}
  /** The same structure as 'this.schemas', but with ref cycles removed  */
  public decycledSchemas: Record<string, RoboField<AccessGroup>[]> = {}
  public accessGroups: Record<AccessGroup, readonly Namespace[]>
  public operations: OperationType[] = ['C', 'R', 'U', 'D', 'S']
  public timings: MiddlewareTiming[] = ['after', 'before']
  public groupTypes = { read: 'readGroups', write: 'writeGroups' } as const
  public guardTypes = { read: 'readGuards', write: 'writeGuards' } as const

  /** The fields of the RoboFile model */
  private roboFileShema: RoboField<AccessGroup>[] = []
  private services: Record<string, Record<string, ServiceFunction>> = {}
  private middlewares: Record<string, Record<OperationType, { after: MiddlewareAfterFunction, before: MiddlewareBeforeFunction }>> = {}
  private logger: Logger
  private upload: multer.Multer | null

  constructor({
    mongooseConnection,
    schemaDir,
    serviceDir = null,
    fileDir = null,
    maxFileCacheAge = 5000,
    maxImageSize = 800,
    createThumbnail = false,
    maxThumbnailSize = 200,
    fileReadMiddleware = null,
    fileUploadMiddleware = null,
    fileDeleteMiddleware = null,
    checkAccess = true,
    namespaces = [],
    accessGroups = [],
    adminGroups = null,
    showErrors = true,
    showWarnings = true,
    showLogs = true,
  }: RobogoConfig<Namespace, AccessGroup>) {
    this.mongooseConnection = mongooseConnection
    this.schemaDir = schemaDir
    this.serviceDir = serviceDir
    this.fileDir = fileDir
    this.maxFileCacheAge = maxFileCacheAge
    this.maxImageSize = maxImageSize
    this.createThumbnail = createThumbnail
    this.maxThumbnailSize = maxThumbnailSize
    this.fileReadMiddleware = fileReadMiddleware
    this.fileUploadMiddleware = fileUploadMiddleware
    this.fileDeleteMiddleware = fileDeleteMiddleware
    this.checkAccess = checkAccess
    this.logger = new Logger({ showErrors, showWarnings, showLogs })
    this.upload = null
    this.namespaces = namespaces
    this.adminGroups = adminGroups

    if (Array.isArray(accessGroups)) {
      const entries = accessGroups.map(group => [group, []])
      this.accessGroups = Object.fromEntries(entries)
    }
    else {
      this.accessGroups = accessGroups
    }

    for (const group in this.accessGroups) {
      for (const namespace of this.accessGroups[group]) {
        if (!this.namespaces.includes(namespace)) {
          this.logger.logUnknownNamespaceInAccessGroup(group, namespace, `processing the access group '${group}'`)
        }
      }
    }
  }

  async init() {
    const roboModel = this.generateModel(RoboFileModel as mongoose.Model<unknown>)
    this.roboFileShema = this.generateSchema(roboModel)
    
    await this.processSchemas()
    this.generateDecycledSchemas()
    this.generatePathSchemas()
    this.collectMinimalRequiredAccessesGroupSetsOfModels()

    if (this.fileDir)
      this.upload = multer({ dest: this.fileDir }) // multer will handle the saving of files, when one is uploaded

    // Imports every file from "serviceDir" into the "services" object
    if (this.serviceDir) {
      for (const serviceFile of await glob(this.serviceDir)) {
        const serviceName = serviceFile.split('/').at(-1)!.split('.')[0]
        const imported = await import(serviceFile) // TODO: some progress reporting would ge great
        this.services[serviceName] = imported.default || imported
      }
    }

    console.log('\n\n\n\n\n\n\n\n')
    // console.log(this.models.Test)
    // console.dir(this.decycledSchemas.Test, {depth: null})
    // console.log(this.services)
    console.log('\n\n\n\n\n\n\n\n')
  }

  /**
   * Imports every model from "SchemaDir" and creates a robogo schema for it.
   * Also creates default middlewares for them.
   * Finally it handles the references between the schemas.
   */
  async processSchemas() {
    for (const schemaPath of await glob(this.schemaDir)) {
      const {default: mongooseModel}: {default: mongoose.Model<unknown>} = await import(schemaPath)
      
      this.models[mongooseModel.modelName] = this.generateModel(mongooseModel)
      this.schemas[mongooseModel.modelName] = this.generateSchema(this.models[mongooseModel.modelName])
      this.middlewares[mongooseModel.modelName] = {
        C: { before: async () => {}, after: async () => {} },
        R: { before: async () => {}, after: async () => {} },
        U: { before: async () => {}, after: async () => {} },
        D: { before: async () => {}, after: async () => {} },
        S: { before: async () => {}, after: async () => {} },
      }
    }

    // // Now every schema is ready, we can ref them in each other and check which one of them needs to be access checked when queried
    for (const modelName in this.schemas) {
      for (const field of this.schemas[modelName])
        this.plugInFieldRef(field, modelName)
    }
  }

  /** Constructs a robogo model instance from a mongoose model instance */
  generateModel(mongooseModel: mongoose.Model<unknown>): Model<Namespace, AccessGroup> {
    const modelName = mongooseModel.modelName

    const roboModel: Model<Namespace, AccessGroup> = {
      model: mongooseModel,
      name: mongooseModel.schema.get('name'),
      namespaces: mongooseModel.schema.get('namespaces') as Namespace[] || [],
      props: mongooseModel.schema.get('props') || {},
      minimalRequriedAccessGroupSets: null,
      readGuards: mongooseModel.schema.get('readGuards') || [],
      writeGuards: mongooseModel.schema.get('writeGuards') || [],
      defaultFilter: mongooseModel.schema.get('defaultFilter') || {},
      defaultSort: this.convertToSortObject(mongooseModel.schema.get('defaultSort') || {}),
    }

    for (const namespace of roboModel.namespaces) {
      if (!this.namespaces.includes(namespace))
        this.logger.logUnknownNamespaceInModel(modelName, namespace, `processing the model '${modelName}'`)
    }

    this.addAccessGroupsToModel(mongooseModel, roboModel)

    return roboModel
  }

  /** Handles adding read and write groups to a model, from its mongoose instance and the global admin groups */
  addAccessGroupsToModel(mongooseModel: mongoose.Model<unknown>, roboModel: Model<Namespace, AccessGroup>) {
    for (const groupType of Object.values(this.groupTypes)) {
      roboModel[groupType] = mongooseModel.schema.get(groupType) as AccessGroup[] | undefined

      this.addAdminGroups(roboModel, roboModel)
      this.validateGroups(roboModel, roboModel)
    }
  }

  /** Add the admin groups to the target's access groups */
  addAdminGroups(target: WithAccessGroups<AccessGroup>, model: Model<Namespace, AccessGroup>) {
    if (!this.adminGroups)
      return

    for (const groupType of Object.values(this.groupTypes)) {
      if (!target[groupType])
        continue

      if (Array.isArray(this.adminGroups)) {
        target[groupType].unshift(...this.adminGroups)
      }
      else if (typeof this.adminGroups == 'object') {
        for (const namespace of model.namespaces) {
          if (!this.adminGroups[namespace])
            continue

          target[groupType].unshift(...this.adminGroups[namespace])
        }
      }
      else {
        this.logger.logIncorrectAdminGroups(this.adminGroups, `processing the admin groups of the model '${model.model.modelName}'`)
      }
    }
  }

  /** We check if there are unknown access groups in 'source', and if so, we warn the user */
  validateGroups(source: WithAccessGroups<AccessGroup>, model: Model<Namespace, AccessGroup>) {
    for (const groupType of Object.values(this.groupTypes)) {
      if (!source[groupType])
        continue

      for (const group of source[groupType]) {
        if (!this.accessGroups[group]) {
          this.logger.logUnknownAccessGroupInModel(model.model.modelName, group, `processing the model '${model.model.modelName}'`)
        }
        else if (
          this.accessGroups[group].length && model.namespaces.length
          && !this.accessGroups[group].some(namespace => model.namespaces.includes(namespace))
        ) {
          this.logger.logIncorrectAccessGroupNamespaceInModel(model.model.modelName, group, this.accessGroups[group], model.namespaces, `processing the model '${model.model.modelName}'`)
        }
      }
    }
  }

  /** Constructs a sort object from the possible sort types (https://mongoosejs.com/docs/api/query.html#Query.prototype.sort()) */
  convertToSortObject(sortValue: SortValue): SortObject {
    // eg.: [['field1', -1], ['field2', 1]]
    if (Array.isArray(sortValue))
      return Object.fromEntries(sortValue)

    // eg.: {field1: -1, field2: 1}
    if (typeof sortValue === 'object')
      return sortValue

    // else its a string
    // eg.: '-field1 field2'
    const sortObj: SortObject = {}
    const entries = sortValue.split(' ')
    for (const entry of entries) {
      const isDesc = entry[0] === '-'

      if (isDesc)
        sortObj[entry.slice(1)] = -1
      else
        sortObj[entry] = 1
    }


    return sortObj
  }

  /** Generates a robogo schema instance from a mongoose model instance. */
  generateSchema(model: Model<Namespace, AccessGroup>) {
    console.log(model.model.modelName)
    return Object.values(model.model.schema.paths)
      .filter(type => type.path !== '_id' && type.path !== '__v')
      .map(type => this.generateRoboField(model, model.model.schema, type))
  }

  /** Generates a RoboField instance from a mongoose SchemaType */
  generateRoboField(model: Model<Namespace, AccessGroup>, schema: mongoose.Schema, type: mongoose.SchemaType): RoboField<AccessGroup> {
    const roboField: RoboField<AccessGroup> = {
      key: type.path,
      type: this.getRoboTypeFromSchemaType(type),
      props: type.options.props || {},
      readGuards: type.options.readGuards || [],
      writeGuards: type.options.writeGuards || [],
    }

    if(type.instance === 'Array')
      roboField.isArray = true

    // these keys are only added if specified
    const optionKeys = ['required', 'name', 'description', 'marked', 'hidden', 'enum', 'autopopulate', 'default', 'readGroups', 'writeGroups'] as const
    for(const key of optionKeys) {
      if(type.options.hasOwnProperty(key))
        roboField[key] = type.options[key]
    }

    if(type.options.hasOwnProperty('ref')) {
      const isModelInstance = typeof type.options.ref === 'function'
      roboField.ref = isModelInstance ? type.options.ref.modelName : type.options.ref
    }

    this.addAdminGroups(roboField, model)
    this.validateGroups(roboField, model)

    if(roboField.isArray)
      this.addEmbeddedProperties(model, schema, roboField)

    if(type.schema) {
      roboField.type = 'Object'
      roboField.subfields = Object.values(type.schema.paths)
        .filter(type => type.path !== '_id')
        .map(t => this.generateRoboField(model, type.schema, t))
    }

    return roboField
  }

  /** Extrancts and translates the mongoose schema type to a robogo type format */
  getRoboTypeFromSchemaType(type: mongoose.SchemaType): string {
    switch(type.instance) {
      case 'ObjectID': return 'Object'
      case 'Mixed': return 'Object'
      case 'Embedded': return 'Object'
      default: return type.instance
    }
  }

  addEmbeddedProperties(model: Model<Namespace, AccessGroup>, schema: mongoose.Schema, roboField: RoboField<AccessGroup>) {
    const embeddedType = schema.path(`${roboField.key}.$`)
    if(!embeddedType)
      return

    const subField = this.generateRoboField(model, schema, embeddedType)

    roboField.type = subField.type
    roboField.props = {...roboField.props, ...subField.props}
    roboField.readGuards = [...roboField.readGuards, ...subField.readGuards]
    roboField.writeGuards = [...roboField.writeGuards, ...subField.writeGuards]
    
    // add some properties if they do not exist
    const keysToCopy = ['name', 'description', 'marked', 'hidden', 'ref', 'enum', 'default', 'autopopulate'] as const
    for(const key of keysToCopy) {
      if(subField[key] !== undefined)
        // @ts-expect-error this is ok
        roboField[key] ??= subField[key]
    }

    // merge or set read and write access groups
    for(const groupType of Object.values(this.groupTypes)) {
      if(subField[groupType]) {
        if(roboField[groupType])
          roboField[groupType] = [...roboField[groupType], ...subField[groupType]]
        else
          roboField[groupType] = subField[groupType]
      }
    }
  }
  
  plugInFieldRef(field: RoboField<AccessGroup>, modelName: string) {
    if (field.ref) {
      if (field.ref == 'RoboFile')
        field.subfields = this.roboFileShema // RoboFile is not stored in the "Schemas" object as it comes from this library not the user.
      else if (this.schemas[field.ref])
        field.subfields = this.schemas[field.ref] // If the ref is known as a schema, then the fields new subfields are the fields of that schema
      else
        this.logger.logUnknownReference(modelName, field.key, field.ref, `processing the field '${modelName} -> ${field.key}'`)
    }
    else if (field.subfields) {
      for (const fObj of field.subfields)
        this.plugInFieldRef(fObj, field.ref || modelName)
    }
  }

  /** Creates a copy of the schemas with circular references removed from them */
  generateDecycledSchemas() {
    for (const modelName in this.schemas)
      this.decycledSchemas[modelName] = this.schemas[modelName].map(field => this.decycleField(field))
  }

  /** Checks if 'field' is referencing a model, which was already referenced earlier in the tree and if so it removes the subfields */
  decycleField(field: RoboField<AccessGroup>, visitedRefs: string[] = []): RoboField<AccessGroup> {
    const decycledField = {...field}

    if(field.ref) {
      if(visitedRefs.includes(field.ref))
        decycledField.subfields = []
    
      visitedRefs.push(field.ref)
    }
    
    if (decycledField.subfields)
      decycledField.subfields = decycledField.subfields.map(f => this.decycleField(f, visitedRefs))

    return decycledField
  }

  /** Creates a flat representation for the schemas, in which fields can be accessed with a '.' separated path */
  generatePathSchemas() {
    for (const modelName in this.decycledSchemas) {
      this.pathSchemas[modelName] = {}

      for (const field of this.decycledSchemas[modelName])
        this.generatePathSchema(modelName, field)
    }
  }

  /** Recursively adds a field and its subfields to this.decycledSchemas[modelName] */
  generatePathSchema(modelName: string, field: RoboField<AccessGroup>, prefix = '') {
    const path = `${prefix}${field.key}`
    this.pathSchemas[modelName][path] = field

    if (field.subfields) {
      for (const f of field.subfields)
        this.generatePathSchema(modelName, f, `${path}.`)
    }
  }

  /** Calculates the smallest sets of access groups for every model which are enough to read/write every field in them */
  collectMinimalRequiredAccessesGroupSetsOfModels() {
    for (const modelName in this.decycledSchemas) {
      this.models[modelName].minimalRequriedAccessGroupSets = this.collectMinimalRequiredAccessGroupSets({ // TODO: check this change
        subfields: this.decycledSchemas[modelName],
        readGroups: this.models[modelName].readGroups,
        writeGroups: this.models[modelName].writeGroups,
      })
    }
  }

  /** Calculates the smallest sets of access groups to be able to read/write a field and its subfields. */
  collectMinimalRequiredAccessGroupSets(field: Pick<RoboField<AccessGroup>, 'subfields' | 'readGroups' | 'writeGroups' | 'ref'>): Record<AccessType, AccessGroup[][]> {
    const currReadGroups = (field.readGroups || []).map(a => [a])
    const currWriteGroups = (field.writeGroups || []).map(a => [a])

    if (!field.subfields?.length || field.ref == 'RoboFile') { // if the field is a 'leaf' then we return our accesses
      return {
        read: currReadGroups,
        write: currWriteGroups,
      }
    }

    const subfieldResults = (field.ref && this.models[field.ref].minimalRequriedAccessGroupSets)
      ? [this.models[field.ref].minimalRequriedAccessGroupSets!] // SAFETY: This cannot be null, as it is checked in the row above
      : field.subfields.map(f => this.collectMinimalRequiredAccessGroupSets(f))

    return {
      read: this.mergeAccessGroupCombinations(currReadGroups, subfieldResults.map(r => r.read)),
      write: field.ref
        ? currWriteGroups
        : this.mergeAccessGroupCombinations(currWriteGroups, subfieldResults.map(r => r.write)),
    }
  }

  /** Merges the access group combinations in "sourceCombinationsArray" with "targetCombinations" into new minimal access group combinations */
  mergeAccessGroupCombinations(targetCombinations: AccessGroup[][], sourceCombinationsArray: AccessGroup[][][]): AccessGroup[][] {
    sourceCombinationsArray = sourceCombinationsArray.filter(g => g.length)

    if (!sourceCombinationsArray.length)
      return targetCombinations

    if (!targetCombinations.length)
      targetCombinations = [[]] // TODO: check this change

    let resultCombinations = targetCombinations

    for (const sourceCombinations of sourceCombinationsArray) {
      const currentCombinations = new MinimalSetCollection<AccessGroup>()

      for (const sourceCombination of sourceCombinations) {
        for (const prevCombination of resultCombinations) {
          const newCombination = new Set<AccessGroup>([...prevCombination, ...sourceCombination])
          currentCombinations.insert(newCombination)
        }
      }

      resultCombinations = currentCombinations.getArray().map(combination => [...combination])
    }

    return resultCombinations
  }

  // /**
  //  * Returns the field paths of a model that are safe to be used with fuse.js. JSDoc
  //  * @param {(string | Array)} schema
  //  * @param {number} [maxDepth]
  //  */
  // GetSearchKeys(schema, maxDepth = Infinity) {
  //   if (typeof schema == 'string')
  //     schema = this.decycledSchemas[schema] // if string was given, we get the schema descriptor

  //   const keys = []

  //   for (const field of schema)
  //     this.GenerateSearchKeys(field, keys, maxDepth)

  //   return keys
  // }

  // /**
  //  * Recursively collects the field paths of a field and its subfields that are safe to be used with fuse.js.
  //  * @param {object} field - A robogo field descriptor
  //  * @param {Array} keys - Keys will be collected in this array
  //  * @param {number} maxDepth
  //  * @param {*} [prefix] - This parameter should be leaved empty
  //  * @param {*} [depth] - This parameter should be leaved empty
  //  */
  // GenerateSearchKeys(field, keys, maxDepth, prefix = '', depth = 0) {
  //   if (depth > maxDepth)
  //     return

  //   if (!['Object', 'Date'].some(t => field.type == t) && !field.subfields) // fuse.js can not handle values that are not strings or numbers, so we don't collect those keys.
  //     keys.push(`${prefix}${field.key}`)

  //   if (field.subfields) {
  //     for (const f of field.subfields)
  //       this.GenerateSearchKeys(f, keys, maxDepth, `${prefix}${field.key}.`, depth + 1)
  //   }
  // }

  // /**
  //  * Creates a robogo field descriptor from a mongoose one.
  //  * @param {string} fieldKey
  //  * @param {object} fieldDescriptor - A mongoose field descriptor
  //  */
  // GenerateSchemaField(fieldKey, fieldDescriptor, modelName) {
  //   // we basically collect the information we know about the field
  //   const softDeletedOn = fieldDescriptor.options.softDelete
  //   if (softDeletedOn !== undefined)
  //     this.models[modelName].defaultFilter[fieldKey] = { $ne: softDeletedOn }

  //   const field = {
  //     key: fieldKey,
  //     isArray: fieldDescriptor.instance == 'Array',
  //     type: fieldDescriptor.instance,
  //     required: fieldDescriptor.options.required || false,
  //     name: fieldDescriptor.options.name || null,
  //     description: fieldDescriptor.options.description || null,
  //     props: fieldDescriptor.options.props || {},
  //     readGuards: fieldDescriptor.options.readGuards || [],
  //     writeGuards: fieldDescriptor.options.writeGuards || [],
  //   }
  //   if (fieldDescriptor.options.marked)
  //     field.marked = true
  //   if (fieldDescriptor.options.hidden)
  //     field.hidden = true
  //   if (fieldDescriptor.options.ref)
  //     field.ref = fieldDescriptor.options.ref
  //   if (fieldDescriptor.options.enum)
  //     field.enum = fieldDescriptor.options.enum
  //   if (fieldDescriptor.options.autopopulate)
  //     field.autopopulate = fieldDescriptor.options.autopopulate
  //   if (fieldDescriptor.options.hasOwnProperty('default'))
  //     field.default = fieldDescriptor.options.default
  //   if (fieldDescriptor.options.readGroups)
  //     field.readGroups = fieldDescriptor.options.readGroups
  //   if (fieldDescriptor.options.writeGroups)
  //     field.writeGroups = fieldDescriptor.options.writeGroups

  //   // if the field is an array we extract the informations of the type it holds
  //   if (field.isArray) {
  //     const Emb = fieldDescriptor.$embeddedSchemaType

  //     field.type = Emb.instance || 'Object'
  //     field.name = field.name || Emb.options.name || null
  //     field.description = field.description || Emb.options.description || null
  //     field.props = field.props || Emb.options.props || {}
  //     field.readGuards = [...(field.readGuards || []), ...(Emb.options.readGuards || [])] // collecting all access groups without duplication
  //     field.writeGuards = [...(field.writeGuards || []), ...(Emb.options.writeGuards || [])] // collecting all access groups without duplication

  //     field.subfields = []
  //     if (Emb.options.marked)
  //       field.marked = true
  //     if (Emb.options.hidden)
  //       field.hidden = true
  //     if (Emb.options.ref)
  //       field.ref = Emb.options.ref
  //     if (Emb.options.enum)
  //       field.enum = Emb.options.enum
  //     if (Emb.options.hasOwnProperty('default') && !field.default)
  //       field.default = Emb.options.default
  //     if (Emb.options.autopopulate)
  //       field.autopopulate = Emb.options.autopopulate
  //     if (Emb.options.readGroups)
  //       field.readGroups = [...new Set([...(field.readGroups || []), ...(Emb.options.readGroups || [])])] // collecting all access groups without duplication
  //     if (Emb.options.writeGroups)
  //       field.writeGroups = [...new Set([...(field.writeGroups || []), ...(Emb.options.writeGroups || [])])] // collecting all access groups without duplication
  //   }

  //   for (const groupType of Object.values(this.groupTypes)) {
  //     if (!field[groupType])
  //       continue

  //     // we add the 'adminGroups' to the accessGroups if it was not empty
  //     if (this.adminGroups) {
  //       if (Array.isArray(this.adminGroups)) {
  //         field[groupType].unshift(...this.adminGroups)
  //       }

  //       else if (typeof this.adminGroups == 'object') {
  //         for (const namespace of this.models[modelName].namespaces) {
  //           if (!this.adminGroups[namespace])
  //             continue

  //           field[groupType].unshift(...this.adminGroups[namespace])
  //         }
  //       }

  //       else {
  //         this.logger.LogIncorrectAdminGroups(this.adminGroups, `processing the admin groups of the field '${modelName} -> ${field.key}'`)
  //       }
  //     }

  //     // We check if an access group is used, that was not provided in the constructor,
  //     // if so we warn the developer, because it might be a typo.
  //     for (const group of field[groupType]) {
  //       if (!this.accessGroups[group]) {
  //         this.logger.LogUnknownAccessGroupInField(modelName, field.key, group, `processing the field '${modelName} -> ${field.key}'`)
  //       }
  //       else if (
  //         this.accessGroups[group].length && this.models[modelName].namespaces.length
  //         && !this.accessGroups[group].some(namespace => this.models[modelName].namespaces.includes(namespace))
  //       ) {
  //         this.logger.LogIncorrectAccessGroupNamespaceInField(modelName, field.key, group, this.accessGroups[group], this.models[modelName].namespaces, `processing the field '${modelName} -> ${field.key}'`)
  //       }
  //     }
  //   }

  //   if (field.type == 'ObjectID') {
  //     field.type = 'Object'
  //   }
  //   else if (field.type == 'Embedded') {
  //     field.type = 'Object'
  //     field.subfields = []
  //   }

  //   // If a Mixed type is found we try to check if it was intentional or not
  //   // if not, then we warn the user about the possible error
  //   // TODO: Find a better way to do this
  //   else if (field.type == 'Mixed') {
  //     let givenType = field.type
  //     field.type = 'Object'

  //     if (fieldDescriptor.options) {
  //       if (Array.isArray(fieldDescriptor.options.type)) {
  //         if (Object.keys(fieldDescriptor.options.type[0]).length)
  //           givenType = fieldDescriptor.options.type[0].schemaName || fieldDescriptor.options.type[0].type.schemaName
  //       }
  //       else {
  //         if (Object.keys(fieldDescriptor.options.type).length)
  //           givenType = fieldDescriptor.options.type.schemaName
  //       }
  //     }

  //     if (givenType != 'Mixed')
  //       this.logger.LogMixedType(modelName, fieldKey, field)
  //   }

  //   // if the field has a ref, we check if it is a string or a model
  //   if (field.ref) {
  //     const givenRef = field.ref
  //     const isModel = typeof givenRef == 'function'

  //     field.DBString = isModel ? givenRef.db._connectionString : this.baseDBString // we need to know which connection the ref model is from
  //     field.ref = isModel ? givenRef.modelName : givenRef

  //     // if the model is from another connection, we generate a schema descriptor for it, so we can later use it as ref
  //     if (field.DBString != this.baseDBString) {
  //       if (!this.schemas[field.DBString])
  //         this.schemas[field.DBString] = {}
  //       this.schemas[field.DBString][field.ref] = this.GenerateSchema(givenRef)
  //     }
  //   }

  //   return field
  // }

  // /**
  //  * Recursively creates field descriptors that only have those information, which can be useful on the frontend.
  //  * This function does NOT check field access, if that is needed please provide the result of the RemoveDeclinedFieldsFromSchema call as the first parameter.
  //  * @param {(string | Array)} schema - Model name or robogo schema descriptor
  //  * @param {number} [maxDepth] - Maximum reference depth
  //  * @param {number} [depth] - This parameter should be leaved empty
  //  */
  // GetFields(schema, maxDepth = Infinity, depth = 0) {
  //   if (typeof schema == 'string')
  //     schema = (maxDepth == Infinity ? this.decycledSchemas : this.schemas[this.baseDBString])[schema] // if string was given, we get the schema descriptor

  //   const fields = []

  //   for (const field of schema) {
  //     if (field.hidden)
  //       continue // fields marked as hidden should not be included in fields
  //     const fieldDescriptor = {}

  //     for (const key of ['name', 'key', 'description', 'type', 'isArray', 'marked']) // we copy theese fields as they are useful on the frontend
  //       fieldDescriptor[key] = field[key]

  //     // if current depth is lower then max, we collect the descriptors of the subfields
  //     if (field.subfields && depth < maxDepth)
  //       fieldDescriptor.subfields = this.GetFields(field.subfields, maxDepth, field.ref ? depth + 1 : depth)

  //     fields.push(fieldDescriptor)
  //   }

  //   return fields
  // }

  // /**
  //  * Helper function, that is used when an image was uploaded.
  //  * It will resize the image to the specified size if needed.
  //  * It will create a RoboFile document for the image, with the properties of the image.
  //  * It will also create a thumbnail of the image if needed.
  //  * @param {object} req
  //  * @param {object} res
  //  */
  // handleImageUpload(req, res) {
  //   const multerPath = req.file.path
  //   const type = req.file.mimetype
  //   const extension = req.file.originalname.split('.').pop()
  //   const filePath = `${req.file.filename}.${extension}` // the image will be saved with the extension attached

  //   let newSize = req.file.size // this will be overwritten with the size after the resizing
  //   this.resizeImageTo(multerPath, this.maxImageSize, `${multerPath}.${extension}`) // resizes and copies the image
  //     .then((size) => {
  //       if (size) // if 'this.maxImageSize' is set to null, then no resizing was done (and 'size' is undefined)
  //         newSize = size

  //       if (this.createThumbnail) // if a thumbnail is needed create one
  //         return this.resizeImageTo(multerPath, this.maxThumbnailSize, `${multerPath}_thumbnail.${extension}`)
  //     })
  //     .then(() => fs.promises.unlink(multerPath)) // we don't need the original image anymore
  //     .then(() => RoboFileModel.create({ // we create the RoboFile document
  //       name: req.file.originalname,
  //       path: filePath,
  //       type,
  //       size: newSize,
  //       extension,
  //       isImage: true,
  //       ...this.createThumbnail && { thumbnailPath: `${req.file.filename}_thumbnail.${extension}` }, // A hacky way of only append thumbnailPath to an object, when createThumbnail is true
  //     }))
  //     .then(file => res.send(file))
  //     .catch((err) => {
  //       console.error(err)
  //       res.status(500).send(err)
  //     })
  // }

  // /**
  //  * Resizes an image at the sourcePath to the given size and saves it to the destinationPath.
  //  * @param {string} sourcePath
  //  * @param {number} size
  //  * @param {string} destinationPath
  //  */
  // resizeImageTo(sourcePath, size, destinationPath) {
  //   if (size == null)
  //     return fs.promises.copyFile(sourcePath, destinationPath) // if size is null, we do not resize just save it to the destination path

  //   return new Promise((resolve, reject) => {
  //     sharp(sourcePath)
  //       .rotate()
  //       .resize(size, size, {
  //         fit: 'inside',
  //         withoutEnlargement: true, // if the size was already smaller then specified, we do not enlarge it
  //       })
  //       .toFile(destinationPath, (err, info) => {
  //         if (err)
  //           reject(err)
  //         else resolve(info.size)
  //       })
  //   })
  // }

  // /**
  //  * Adds a middleware function to the given model.
  //  * @param {string} modelName
  //  * @param {string} operation
  //  * @param {string} timing
  //  * @param {Function} middlewareFunction
  //  */
  // addMiddleware(modelName, operation, timing, middlewareFunction) {
  //   const errorOccurrence = `adding the custom middleware '${modelName} -> ${operation} -> ${timing}'`

  //   if (!this.middlewares[modelName]) {
  //     this.logger.LogMissingModel(modelName, errorOccurrence)
  //     throw new Error(`MISSING MODEL: ${modelName}`)
  //   }
  //   if (!this.operations.includes(operation)) {
  //     this.logger.LogUnknownOperation(operation, errorOccurrence)
  //     throw new Error(`Middleware: Operation should be one of: ${this.operations}`)
  //   }
  //   if (!this.timings.includes(timing)) {
  //     this.logger.LogUnknownTiming(timing, errorOccurrence)
  //     throw new Error(`Middleware: Timing should be one of: ${this.timings}`)
  //   }

  //   this.middlewares[modelName][operation][timing] = middlewareFunction
  // }
  
  // async RemoveDeclinedFieldsFromSchema(fields, req, mode) {
  //   let model = null
  //   if (typeof fields == 'string') { // if model name was given, then we get the models fields
  //     model = fields
  //     fields = this.decycledSchemas[model]
  //   }

  //   if (!fields.length)
  //     return Promise.resolve(fields)

  //   const checkGroupAccess = !model || !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)
  //   const fieldPromises = []

  //   const guardPreCache = await this.calculateGuardPreCache(req, fields, mode)
  //   for (const field of fields) {
  //     const promise = this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardPreCache })
  //       .then((declined) => {
  //         if (declined)
  //           return Promise.reject()

  //         const promises = [{ ...field }]

  //         if (field.subfields) {
  //           const promise = this.RemoveDeclinedFieldsFromSchema(field.subfields, req, mode) // IMPROVEMENT: we should pass the field.ref to the recursion, so it can optimize more, but it should be passed alongside the fields so we don't get into a infinite loop.
  //           promises.push(promise)
  //         }

  //         return Promise.all(promises)
  //       })
  //       .then(([newField, subfields]) => {
  //         if (subfields)
  //           newField.subfields = subfields
  //         return newField
  //       })

  //     fieldPromises.push(promise)
  //   }

  //   return Promise.allSettled(fieldPromises)
  //     .then(res => res.filter(r => r.status == 'fulfilled').map(r => r.value))
  // }

  // getAccesses(model, req) {
  //   const accesses = {}
  //   const schema = this.schemas[this.baseDBString][model]

  //   // first we check for read and write accesses on the model itself
  //   return Promise.all([
  //     this.hasModelAccess(model, 'read', req),
  //     this.hasModelAccess(model, 'write', req),
  //   ])
  //     .then(([canReadModel, canWriteModel]) => {
  //       accesses.model = {
  //         read: canReadModel,
  //         write: canWriteModel,
  //       }

  //       // then we go and check each field
  //       const fieldPromises = []
  //       for (const mode of ['read', 'write']) {
  //         let promise = Promise.resolve([])

  //         if (accesses.model[mode]) {
  //           const checkGroupAccess = !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)
  //           promise = this.getFieldAccesses({ fields: schema, mode, req, checkGroupAccess })
  //         }

  //         fieldPromises.push(promise)
  //       }

  //       return Promise.all(fieldPromises)
  //     })
  //     .then(([[canReadAllRequired, read], [canWriteAllRequired, write]]) => {
  //       accesses.fields = {}

  //       // we merge the read and write accesses into one object
  //       const fieldAccesses = { read, write }
  //       for (const mode of ['read', 'write']) {
  //         for (const field in fieldAccesses[mode]) {
  //           if (!accesses.fields[field])
  //             accesses.fields[field] = {}

  //           accesses.fields[field][mode] = fieldAccesses[mode][field]
  //         }
  //       }

  //       // once field access are collected, we remove those entries where there is neither read nor write access
  //       for (const path in accesses.fields) {
  //         const field = accesses.fields[path]
  //         if (!field.write && !field.read)
  //           delete accesses.fields[path]
  //       }

  //       accesses.model.writeAllRequired = accesses.model.write && canWriteAllRequired

  //       return accesses
  //     })
  // }

  // /**
  //  * Retrieves field accesses based on specified parameters.
  //  * @async
  //  * @param {object} params - The parameters for retrieving field accesses.
  //  * @param {Array} params.fields - The array of fields to retrieve accesses for.
  //  * @param {string} params.mode - The mode specifying the retrieval behavior.
  //  * @param {object} params.req - The request object associated with the operation.
  //  * @param {boolean} [params.checkGroupAccess] - Flag indicating whether to check group access.
  //  * @param {object} [params.accesses] - The object to store the retrieved accesses.
  //  * @param {string} [params.prefix] - The prefix for field names.
  //  * @param {Map?} [params.guardPreCache] - The pre-cache guard object.
  //  * @returns {Promise} A Promise that resolves with the retrieved field accesses.
  //  */
  // async getFieldAccesses({ fields, mode, req, checkGroupAccess, accesses = {}, prefix = '', guardPreCache = null }) {
  //   guardPreCache = guardPreCache || await this.calculateGuardPreCache(req, fields, mode)

  //   const promises = fields.map(field => this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardPreCache }))
  //   const results = await Promise.all(promises)

  //   const subPromises = []
  //   let trueForAllRequired = true
  //   for (const field of fields) {
  //     const absolutePath = prefix + field.key
  //     accesses[absolutePath] = !results.shift()

  //     if (field.required && !accesses[absolutePath])
  //       trueForAllRequired = false

  //     if (field.subfields && !field.ref && accesses[absolutePath]) {
  //       const promise = this.getFieldAccesses({ fields: field.subfields, mode, req, checkGroupAccess, accesses, prefix: `${absolutePath}.`, guardPreCache })
  //       subPromises.push(promise)
  //     }
  //   }

  //   const res = await Promise.all(subPromises)
  //   const trueForAllSubRequired = !res.some(([forAll]) => !forAll)

  //   return [trueForAllRequired && trueForAllSubRequired, accesses]
  // }

  // /**
  //  * A helper function, that is a template for Service routes.
  //  * @param {object} req
  //  * @param {object} res
  //  * @param {string} paramsKey
  //  */
  // ServiceRoute(req, res, paramsKey) {
  //   if (!this.services[req.params.service]) {
  //     this.logger.LogMissingService(req.params.service, `serving the route: '${req.method} ${req.path}'`)
  //     return res.status(500).send('MISSING SERVICE')
  //   }
  //   if (!this.services[req.params.service][req.params.fun]) {
  //     this.logger.LogMissingServiceFunction(req.params.service, req.params.fun, `serving the route: '${req.method} ${req.path}'`)
  //     return res.status(500).send('MISSING SERVICE FUNCTION')
  //   }

  //   this.services[req.params.service][req.params.fun]
  //     .call(this, req, res, req[paramsKey])
  //     .then(result => res.send(result))
  //     .catch(error => res.status(500).send(error))
  // }

  /** A helper function, that is a template for the CRUDS category routes. */
  async CRUDSRoute<T>({req, res, operation, mainPart, responsePart}: {
    req: Request,
    res: Response,
    operation: OperationType
    mainPart: () => Promise<T>,
    responsePart: (result: T) => Promise<void>,
  }) {
    // if the model is unkown send an error
    if (!this.schemas[req.params.model]) {
      this.logger.logMissingModel(req.params.model, `serving the route: '${req.method} ${req.path}'`)
      return res.status(400).send('MISSING MODEL')
    }

    const mode: AccessType = ['C', 'U', 'D'].includes(operation) ? 'write' : 'read'

    // the code below calls the middleware and normal parts of the route and handles their errors correspondingly
    const middlewareFunctions = this.middlewares[req.params.model][operation]
    try {
      await middlewareFunctions.before.call(this, req, res)
        .catch(err => {throw new MiddlewareError('before', err)})

      const hasAccess = await this.hasModelAccess(req.params.model, mode, req)
      if (!hasAccess)
        return res.status(403).send()

      const result = await mainPart.call(this)

      await middlewareFunctions.after.call(this, req, res, result)
        .catch(err => {throw new MiddlewareError('after', err)})

      await responsePart.call(this, result)
    }
    catch(err) {
      if(err instanceof MiddlewareError) {
        this.logger.logMiddlewareMessage(req.params.model, operation, err.type, err.message)
      }
      else {
        res.status(500).send(err)
        console.error(err)
      }
    }    
  }

  async hasModelAccess(modelName: string, mode: AccessType, req: Request): Promise<boolean> {
    if (mode == 'read' && !req.checkReadAccess)
      return true
    if (mode == 'write' && !req.checkWriteAccess)
      return true
    
    const groupType = this.groupTypes[mode]
    if (!this.hasGroupAccess(this.models[modelName][groupType], req.accessGroups as AccessGroup[]))
      return false

    const guardType = this.guardTypes[mode]
    if (this.models[modelName][guardType]) {
      const promises = this.models[modelName][guardType].map(guard => promisify(guard(req)))
      const res = await Promise.all(promises)
      return !res.some(r => !r)
    }

    return true
  }

  /** Checks if the two given arrays have an intersection or not. */
  hasGroupAccess(goodGroups: undefined | AccessGroup[], accessGroups: AccessGroup[]) {
    return !goodGroups || goodGroups.some(gg => accessGroups.includes(gg))
  }

  /** Removes declined fields from an object. */
  async removeDeclinedFieldsFromObject({object, mode, req, guardPreCache, ...params}: { 
    object: Partial<MongooseDocument> | null
    mode: AccessType
    req: Request
    guardPreCache?: GuardPreCache
  } & ({
    fields: RoboField<AccessGroup>[]
  } | {
    modelName: string
  })): Promise<void> {
    if (!object)
      return

    const fields = 'fields' in params ? params.fields : this.schemas[params.modelName]
    const fieldsInObj = fields.filter(field => object.hasOwnProperty(field.key))
    if (!fieldsInObj.length)
      return

    if ('modelName' in params) {
      const hasModelAccess = await this.hasModelAccess(params.modelName, mode, req)
      if (!hasModelAccess) {
        delete object._id
        for (const field of fieldsInObj)
          delete object[field.key]

        return
      }
    }

    const checkGroupAccess = !('modelName' in params) || !this.hasEveryNeededAccessGroup(params.modelName, mode, req.accessGroups as AccessGroup[])
    guardPreCache = guardPreCache || await this.calculateGuardPreCache(req, fieldsInObj, mode)

    const promises = fieldsInObj.map(field => this.removeDeclinedFieldsFromObjectHelper({object, req, field, mode, checkGroupAccess, guardPreCache}))
    await Promise.all(promises)
  }

  async removeDeclinedFieldsFromObjectHelper({ object, req, field, mode, checkGroupAccess, guardPreCache }: {
    object: Partial<MongooseDocument>
    mode: AccessType
    req: Request
    guardPreCache: GuardPreCache
    checkGroupAccess: boolean
    field: RoboField<AccessGroup>
  }) {
    const declined = await this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardPreCache })
    if (declined) {
      delete object[field.key]
    }
    else if (field.subfields && (mode === 'read' || !field.ref)) { // we only recurse to the subobjects if reading, or when writing but the field is not a reference
      const fieldsOrModel = field.ref ? {modelName: field.ref} : {fields: field.subfields}

      if (Array.isArray(object[field.key])) {
        const promises = (object[field.key] as Array<object>).map(obj => this.removeDeclinedFieldsFromObject({ ...fieldsOrModel, object: obj, mode, req, guardPreCache }))
        await Promise.all(promises)
      }
      else {
        await this.removeDeclinedFieldsFromObject({ ...fieldsOrModel, object: object[field.key] as object, mode, req, guardPreCache })
      }
    }
  }

  /** Checks if there is minimal required access groups set for the model, of which every group is in the requests access groups */
  hasEveryNeededAccessGroup(modelName: string, mode: AccessType, accessGroups: AccessGroup[]) {
    return this.models[modelName].minimalRequriedAccessGroupSets![mode].some(as => as.every(ag => accessGroups.includes(ag)))
  }

  /** Calculates a Map of every access guard function and their results, that appear on the given fields */
  async calculateGuardPreCache(req: Request, fields: RoboField[], mode: AccessType): Promise<GuardPreCache> {
    const guardType = this.guardTypes[mode]

    const guards = new Set<GuardFunction>()
    for (const field of fields) {
      for (const guard of field[guardType]) {
        guards.add(guard)
      }
    }

    const promises = [...guards].map(g => promisify(g.call(this, req)))
    const res = await Promise.allSettled(promises)

    const preCache = new Map<GuardFunction, boolean>()
    for (const guard of guards) {
      const result = res.shift()!
      const guardValue = result.status == 'fulfilled' && result.value

      preCache.set(guard, guardValue)
    }

    return preCache
  }

  /** Checks if the given field is readable/writeable with the request */
  async isFieldDeclined({ req, field, mode, checkGroupAccess = true, guardPreCache = null }: {
    req: Request
    field: RoboField<AccessGroup>
    mode: AccessType
    checkGroupAccess?: boolean
    guardPreCache?: null | GuardPreCache
  }): Promise<boolean> {
    const shouldCheckAccess = mode == 'read' ? req.checkReadAccess : req.checkWriteAccess
    if (!shouldCheckAccess)
      return false

    if (checkGroupAccess) {
      const groupType = this.groupTypes[mode]
      if (!this.hasGroupAccess(field[groupType], req.accessGroups as AccessGroup[]))
        return true
    }

    return this.isFieldDecliendByGuards(req, field, mode, guardPreCache)
  }

  /** Checks if the field is declined by the guard functions defined on it. */
  async isFieldDecliendByGuards(
    req: Request,
    field: RoboField<AccessGroup>,
    mode: AccessType,
    guardPreCache: null | GuardPreCache = null
  ): Promise<boolean> {
    const guardType = this.guardTypes[mode]
    if (!field[guardType].length)
      return false

    const promises = field[guardType].map(async (guard) => {
      if (guardPreCache && guardPreCache.has(guard))
        return guardPreCache.get(guard)!
      else
        return promisify(guard.call(this, req))
    })

    return Promise.all(promises)
      .then(res => res.some(r => !r))
      .catch(() => true)
  }

  /** Removes every field that are not readable/writeable with the provided request in every document. */
  async removeDeclinedFields({documents, mode, req, ...params}: {
    documents: MongooseDocument[],
    mode: AccessType,
    req: Request
  } & ({
    fields: RoboField<AccessGroup>[]
  } | {
    modelName: string
  })) {
    const fields = 'fields' in params ? params.fields : this.schemas[params.modelName]
    const guardPreCache = await this.calculateGuardPreCache(req, fields, mode)

    const promises = documents.map(doc => this.removeDeclinedFieldsFromObject({ ...params, object: doc, mode, req, guardPreCache }))
    await Promise.all(promises)
  }

  async processFilter(req: Request) {
    const originalFilter: FilterObject = JSON.parse(req.query.filter as string || '{}')
    const extendedFilter = await this.extendFilterWithDefaults(req.params.model, originalFilter)
    const checkedFilter = await this.removeDeclinedFieldsFromFilter(req, extendedFilter)

    return checkedFilter
  }

  /** Extends the given filter object with the given models default filters (if any) */
  async extendFilterWithDefaults(modelName: string, filter: FilterObject): Promise<FilterObject> {
    const defaultFilter = this.models[modelName].defaultFilter

    if (!Object.keys(defaultFilter).length)
      return { ...filter }

    const defaultFilterCopy: FilterObject = JSON.parse(JSON.stringify(defaultFilter))
    await this.visitFilter({
      filter,
      conditionVisitor: path => delete defaultFilterCopy[path],
    })

    return { ...defaultFilterCopy, ...filter }
  }

  /** Removes the fields from a filter which can't be read/written with the provided request */
  async removeDeclinedFieldsFromFilter(req: Request, filter: FilterObject) {
    return await this.visitFilter({
      filter,
      conditionVisitor: async (path, value) => {
        const isDeclined = await this.isFieldDeclined({ req, field: this.pathSchemas[req.params.model][path], mode: 'read' })

        if (isDeclined)
          return Promise.reject()
        else
          return value
      },
      groupVisitor: (results) => {
        const conditions = results.filter(result => Object.keys(result).length)

        if (!conditions.length)
          return Promise.reject()
        else
          return conditions
      },
    })
  }

  /** Visits every condition and group in a filter object. It can also be used to construct a new filter object. */
  async visitFilter({ filter, groupVisitor = conditions => conditions, conditionVisitor = (_path, value) => value }: {
    filter: FilterObject
    conditionVisitor?: (path: string, value: unknown) => MaybePromise<unknown>
    groupVisitor?: (conditions: FilterObject[]) => MaybePromise<FilterObject[]>
  }): Promise<FilterObject> {
    const result: FilterObject = {}
    const promises = []

    for (const outerKey in filter) {
      if (outerKey === '_id') {
        result._id = filter._id
        continue
      }

      if (outerKey == '$and' || outerKey == '$or') {
        const conditionPromises = filter[outerKey]!.map(condition => this.visitFilter({ filter: condition, groupVisitor, conditionVisitor }))
        const conditions = await Promise.all(conditionPromises)

        const promise = promisify(groupVisitor(conditions))
          .then(value => result[outerKey] = value)

        promises.push(promise)
      }
      else {
        const promise = promisify(conditionVisitor(outerKey, filter[outerKey]))
          .then(value => result[outerKey] = value)

        promises.push(promise)
      }
    }

    await Promise.allSettled(promises)
    return result
  }

  /** Adds the default sorts to the requests sort param (if any) and removes those fields from the sort object, that are not readable by the provided request */
  async processSort(req: Request) {
    const sortValue: SortValue = JSON.parse(req.query.sort as string || '{}')
    const sortObject = this.convertToSortObject(sortValue)

    const sort = { ...this.models[req.params.model].defaultSort, ...sortObject }

    const promises = []
    for (const path in sort) {
      const promise = this.isFieldDeclined({ req, field: this.pathSchemas[req.params.model][path], mode: 'read' })
        .then((isDeclined) => {
          if (isDeclined)
            delete sort[path]
        })

      promises.push(promise)
    }
    await Promise.all(promises)

    return sort
  }

  /** Generates all the routes of robogo and returns the express router. */
  generateRoutes() {
    Router.use((req, res, next) => {
      if (req.accessGroups === undefined)
        req.accessGroups = []

      if (req.checkReadAccess === undefined)
        req.checkReadAccess = this.checkAccess

      if (req.checkWriteAccess === undefined)
        req.checkWriteAccess = this.checkAccess

      next()
    })

    // CREATE routes
    Router.post('/create/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'C',
        mainPart: async () => {
          if (req.checkWriteAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: req.body, mode: 'write', req })
  
          return this.mongooseConnection.model(req.params.model).create(req.body)
        },
        responsePart: async result => {
          if (req.checkReadAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: result.toObject(), mode: 'read', req }) // .toObject() is needed, because create returns an immutable object by default 
  
          res.send(result)
        },
      })
    })
    // ----------------

    // READ routes
    // these routes will use "lean" so that results are not immutable
    Router.get('/read/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'R',
        mainPart: async () => {
          const [filter, sort] = await Promise.all([
              this.processFilter(req),
              this.processSort(req)
          ])
  
          return this.mongooseConnection.model(req.params.model)
            .find(filter, req.query.projection)
            .sort(sort)
            .skip(Number(req.query.skip) || 0)
            .limit(Number(req.query.limit) || Infinity)
            .lean({ autopopulate: true, virtuals: true, getters: true })
        },
        responsePart: async results => {
          if (req.checkReadAccess)
            await this.removeDeclinedFields({modelName: req.params.model, documents: results as MongooseDocument[], mode: 'read', req})
  
          res.send(results)
        }
      })
    })

    Router.get('/get/:model/:id', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'R',
        mainPart: async () => {
          return this.mongooseConnection.model(req.params.model)
            .findOne({ _id: req.params.id }, req.query.projection)
            .lean({ autopopulate: true, virtuals: true, getters: true })
        },
        responsePart: async result => {
          if (req.checkReadAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: result as MongooseDocument | null, mode: 'read', req })
  
          res.send(result)
        }
      })
    })
    // ----------------

    // UPDATE routes
    Router.patch('/update/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'U',
        mainPart: async () => {
          if (req.checkWriteAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: req.body, mode: 'write', req })
  
          return this.mongooseConnection.model(req.params.model)
            .updateOne({ _id: req.body._id }, req.body)
        },
        responsePart: async result => {
          res.send(result)
        }
      })
    })
    // ----------------

    // DELETE routes
    Router.delete('/delete/:model/:id', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'D',
        mainPart: async () => {
          const accesses = await this.getAccesses(req.params.model, req)

          if (!accesses.model.write || Object.values(accesses.fields).some(({ write }) => !write))
            return Promise.reject('FORBIDDEN')
  
          return this.mongooseConnection.model(req.params.model)
            .deleteOne({ _id: req.params.id })
        },
        responsePart: async result => {
          res.send(result)
        }
      })
    })
    // ----------------

    // SERVICE routes
    Router.post('/runner/:service/:fun', (req, res) => {
      this.ServiceRoute(req, res, 'body')
    })

    Router.get('/getter/:service/:fun', (req, res) => {
      this.ServiceRoute(req, res, 'query')
    })
    // ----------------

    // FILE routes
    if (this.fileDir) {
      Router.use(
        `${this.serveStaticPath}`,
        (req, res, next) => {
          if (!this.fileReadMiddleware)
            return next()

          promisify(this.fileReadMiddleware(req))
            .then(() => next())
            .catch(reason => res.status(403).send(reason))
        },
        express.static(path.resolve(__dirname, this.fileDir), { maxAge: this.maxFileCacheAge }),
      )
      Router.use(`${this.serveStaticPath}`, (req, res) => res.status(404).send('NOT FOUND')) // If a file is not found in FileDir, send back 404 NOT FOUND

      Router.post(
        '/fileupload',
        (req, res, next) => {
          if (!this.fileUploadMiddleware)
            return next()

          promisify(this.fileUploadMiddleware(req))
            .then(() => next())
            .catch(reason => res.status(403).send(reason))
        },
        this.upload.single('file'),
        (req, res) => {
          if (req.file.mimetype.startsWith('image'))
            return this.handleImageUpload(req, res)

          const multerPath = req.file.path
          const type = req.file.mimetype
          const extension = req.file.originalname.split('.').pop()
          const filePath = `${req.file.filename}.${extension}` // the file will be saved with the extension attached

          fs.renameSync(multerPath, `${multerPath}.${extension}`)

          const fileData = {
            name: req.file.originalname,
            path: filePath,
            size: req.file.size,
            extension,
            type,
          }

          // we create the RoboFile document with the properties of the file
          RoboFileModel.create(fileData, (err, file) => {
            if (err)
              res.status(500).send(err)
            else res.send(file)
          })
        },
      )

      Router.post(
        '/fileclone/:id',
        (req, res, next) => {
          if (!this.fileUploadMiddleware)
            return next()

          promisify(this.fileUploadMiddleware(req))
            .then(() => next())
            .catch(reason => res.status(403).send(reason))
        },
        (req, res) => {
          RoboFileModel.findOne({ _id: req.params.id }).lean()
            .then((roboFile) => {
              const realPath = path.resolve(this.fileDir, roboFile.path)
              if (!realPath.startsWith(this.fileDir))
                return Promise.reject('INVALID PATH')

              const copyRealPath = realPath.replace('.', '_copy.')
              if (fs.existsSync(realPath))
                fs.copyFileSync(realPath, copyRealPath)

              if (roboFile.thumbnailPath) {
                const thumbnailPath = path.resolve(this.fileDir, roboFile.thumbnailPath)
                if (!thumbnailPath.startsWith(this.fileDir))
                  return Promise.reject('INVALID PATH')

                const copyThumbnailPath = thumbnailPath.replace('.', '_copy.')
                if (fs.existsSync(thumbnailPath))
                  fs.copyFileSync(thumbnailPath, copyThumbnailPath)
              }

              delete roboFile._id
              roboFile.path = roboFile.path.replace('.', '_copy.')
              roboFile.thumbnailPath = roboFile.thumbnailPath.replace('.', '_copy.')

              return RoboFileModel.create(roboFile)
            })
            .then(file => res.send(file))
            .catch(err => res.status(500).send(err))
        },
      )

      Router.delete(
        '/filedelete/:id',
        (req, res, next) => {
          if (!this.fileDeleteMiddleware)
            return next()

          promisify(this.fileDeleteMiddleware(req))
            .then(() => next())
            .catch(reason => res.status(403).send(reason))
        },
        (req, res) => {
          RoboFileModel.findOne({ _id: req.params.id })
            .then((file) => {
              if (!file)
                return Promise.reject('Unkown file')

              // we remove both the file and thumbnail if they exists
              const realPath = path.resolve(this.fileDir, file.path)
              if (!realPath.startsWith(this.fileDir))
                return Promise.reject('INVALID PATH') // for safety, if the resolved path is outside of FileDir we return 500 INVALID PATH
              if (fs.existsSync(realPath))
                fs.unlinkSync(realPath)

              if (file.thumbnailPath) {
                const thumbnailPath = path.resolve(this.fileDir, file.thumbnailPath)
                if (!thumbnailPath.startsWith(this.fileDir))
                  return Promise.reject('INVALID PATH') // for safety, if the resolved path is outside of FileDir we return 500 INVALID PATH
                if (fs.existsSync(thumbnailPath))
                  fs.unlinkSync(thumbnailPath)
              }

              // we delete the RoboFile document
              return RoboFileModel.deleteOne({ _id: file._id })
            })
            .then(() => res.send())
            .catch(err => res.status(400).send(err))
        },
      )
    }
    // --------------

    // SPECIAL routes
    Router.get('/model/:model', (req, res) => {
      async function mainPart(req, res) {
        return await this.hasModelAccess(req.params.model, 'read', req)
      }

      async function responsePart(req, res, hasAccess) {
        if (!req.checkReadAccess || hasAccess)
          res.send({ ...this.Models[req.params.model], model: req.params.model })
        else
          res.status(403).send()
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get('/model', (req, res) => {
      const promises = []
      for (const modelName in this.models) {
        const promise = this.hasModelAccess(modelName, 'read', req)
        promises.push(promise)
      }

      Promise.all(promises)
        .then((results) => {
          const models = []

          for (const modelName in this.models) {
            if (req.checkReadAccess && !results.shift())
              continue

            models.push({ ...this.models[modelName], model: modelName })
          }

          res.send(models)
        })
    })

    Router.get('/schema/:model', (req, res) => {
      async function mainPart(req, res) {
        return this.DecycledSchemas[req.params.model]
      }

      async function responsePart(req, res, result) {
        if (req.checkReadAccess)
          result = await this.RemoveDeclinedFieldsFromSchema(result, req, 'read')

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get('/fields/:model', (req, res) => {
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if (req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req, 'read')

        const fields = this.GetFields(schema, req.query.depth)
        return fields
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get('/count/:model', (req, res) => {
      async function mainPart(req, res) {
        const filter = await this.processFilter(req)

        return this.MongooseConnection.model(req.params.model)
          .countDocuments(filter)
      }

      async function responsePart(req, res, result) {
        res.send(String(result))
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get('/searchkeys/:model', (req, res) => {
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if (req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req, 'read')

        return this.GetSearchKeys(schema, req.query.depth)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get('/accessesGroups', (req, res) => {
      const result = Object.keys(this.accessGroups)
      res.send(result)
    })

    Router.get('/accesses/:model', async (req, res) => {
      try {
        const accesses = await this.getAccesses(req.params.model, req)
        res.send(accesses)
      }
      catch (err) {
        res.status(500).send()
      }
    })

    return Router
  }
}

function promisify<T>(value: T): Promise<Awaited<T>>  {
  if (value instanceof Promise)
    return value
  else
    return Promise.resolve(value)
}
