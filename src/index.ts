import type { Request, RequestHandler, Response, Router } from 'express'
import type mongoose from 'mongoose'
import type { RoboFile } from './mongooseTypes.js'
import type { Accesses, AccessType, FieldType, FileMiddlewareFunction, FilterObject, GuardFunction, GuardResults, MaybePromise, MiddlewareAfterFunction, MiddlewareBeforeFunction, MiddlewareTiming, Model, MongooseDocument, OperationType, Optional, RoboField, ServiceFunction, SortObject, SortValue, WithAccessGroups } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { glob } from 'glob'
import multer, { Field } from 'multer'
import sharp from 'sharp'
import RoboFileModel from './schemas/roboFile.js'
import Logger from './utils/logger.js'
import MinimalSetCollection from './utils/minimalSetCollection.js'

export * from './mongooseTypes.js'

class MiddlewareError extends Error {
  constructor(public type: MiddlewareTiming, err: Error) {
    super(type, { cause: err })
  }
}

interface RobogoConfig<Namespace extends string, AccessGroup extends string> {
  /** The mongoose connection instance */
  mongooseConnection: mongoose.Connection
  /** Glob pattern to the schema files (eg.: './schemas/*.ts')  */
  schemaPathGlob: string
  /** Glob pattern to the service files (eg.: './services/*.ts')  */
  servicePathGlob?: string | null
  /** Absolute path to the directory in which robogo should store the uploaded files */
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
export default class Robogo<Namespace extends string = string, AccessGroup extends string = string> {
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
  public accessTypes = ['read', 'write'] as const
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
    schemaPathGlob,
    servicePathGlob = null,
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
    this.schemaPathGlob = schemaPathGlob
    this.servicePathGlob = servicePathGlob
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

    // Imports every file from "servicePathGlob" into the "services" object
    if (this.servicePathGlob) {
      for (const serviceFile of await glob(this.servicePathGlob)) {
        const serviceName = serviceFile.split('/').at(-1)!.split('.')[0]
        const imported = await import(serviceFile) // TODO: some progress reporting would ge great
        this.services[serviceName] = imported.default || imported
      }
    }
  }

  /**
   * Imports every model from "SchemaDir" and creates a robogo schema for it.
   * Also creates default middlewares for them.
   * Finally it handles the references between the schemas.
   */
  async processSchemas() {
    for (const schemaPathGlob of await glob(this.schemaPathGlob)) {
      const { default: mongooseModel }: { default: mongoose.Model<unknown> } = await import(schemaPathGlob)

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
        target[groupType]!.unshift(...this.adminGroups)
      }
      else if (typeof this.adminGroups == 'object') {
        for (const namespace of model.namespaces) {
          if (!this.adminGroups[namespace])
            continue

          target[groupType]!.unshift(...this.adminGroups[namespace]!)
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

      for (const group of source[groupType]!) {
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

    if (type.instance === 'Array')
      roboField.isArray = true

    // these keys are only added if specified
    const optionKeys = ['required', 'name', 'description', 'enum', 'autopopulate', 'default', 'readGroups', 'writeGroups'] as const
    for (const key of optionKeys) {
      if (type.options.hasOwnProperty(key))
        roboField[key] = type.options[key]
    }

    if (type.options.hasOwnProperty('ref')) {
      const isModelInstance = typeof type.options.ref === 'function'
      roboField.ref = isModelInstance ? type.options.ref.modelName : type.options.ref
    }

    this.addAdminGroups(roboField, model)
    this.validateGroups(roboField, model)

    if (roboField.isArray)
      this.addEmbeddedProperties(model, schema, roboField)

    if (type.schema) {
      roboField.type = 'Object'
      roboField.subfields = Object.values(type.schema.paths)
        .filter(type => type.path !== '_id')
        .map(t => this.generateRoboField(model, type.schema, t))
    }

    return roboField
  }

  /** Extrancts and translates the mongoose schema type to a robogo type format */
  getRoboTypeFromSchemaType(type: mongoose.SchemaType): FieldType {
    switch (type.instance) {
      case 'ObjectId': return 'Object'
      case 'Mixed': return 'Object'
      case 'Embedded': return 'Object'
      default: return type.instance as FieldType
    }
  }

  addEmbeddedProperties(model: Model<Namespace, AccessGroup>, schema: mongoose.Schema, roboField: RoboField<AccessGroup>) {
    const embeddedType = schema.path(`${roboField.key}.$`)
    if (!embeddedType)
      return

    const subField = this.generateRoboField(model, schema, embeddedType)

    roboField.type = subField.type
    roboField.props = { ...roboField.props, ...subField.props }
    roboField.readGuards = [...roboField.readGuards, ...subField.readGuards]
    roboField.writeGuards = [...roboField.writeGuards, ...subField.writeGuards]

    // add some properties if they do not exist
    const keysToCopy = ['name', 'description', 'ref', 'enum', 'default', 'autopopulate'] as const
    for (const key of keysToCopy) {
      if (subField[key] !== undefined)
        // @ts-expect-error this is ok
        roboField[key] ??= subField[key]
    }

    // merge or set read and write access groups
    for (const groupType of Object.values(this.groupTypes)) {
      if (subField[groupType]) {
        if (roboField[groupType])
          roboField[groupType] = [...roboField[groupType]!, ...subField[groupType]!]
        else
          roboField[groupType] = subField[groupType]
      }
    }
  }

  plugInFieldRef(field: RoboField<AccessGroup>, modelName: string) {
    if (field.ref) {
      if (field.ref === 'RoboFile')
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
    const decycledField = { ...field }

    if (field.ref) {
      if (visitedRefs.includes(field.ref))
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

    if (!field.subfields?.length || field.ref === 'RoboFile') { // if the field is a 'leaf' then we return our accesses
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

  wrapExpressMiddleware(middleware: FileMiddlewareFunction | null): RequestHandler {
    return (req, res, next) => {
      if (!middleware)
        return next()

      promisify(middleware(req))
        .then(() => next())
        .catch(reason => res.status(403).send(reason))
    }
  }

  /**
   * Helper function, that is used when an image was uploaded.
   * It will resize the image to the specified size if needed.
   * It will create a RoboFile document for the image, with the properties of the image.
   * It will also create a thumbnail of the image if needed.
   */
  async handleImageUpload(file: Express.Multer.File) {
    const multerPath = file.path
    const type = file.mimetype
    const extension = file.originalname.split('.').pop()!
    const filePath = `${file.filename}.${extension}`

    const resizedSize = await this.resizeImageTo(multerPath, this.maxImageSize, `${multerPath}.${extension}`)
    const newSize = resizedSize || file.size

    if (this.createThumbnail)
      await this.resizeImageTo(multerPath, this.maxThumbnailSize, `${multerPath}_thumbnail.${extension}`)

    await fs.promises.unlink(multerPath)

    const roboFileData: Omit<RoboFile, '_id'> = {
      name: file.originalname,
      path: filePath,
      type,
      size: newSize,
      extension,
      isImage: true,
    }
    if (this.createThumbnail)
      roboFileData.thumbnailPath = `${file.filename}_thumbnail.${extension}`

    return RoboFileModel.create(roboFileData)
  }

  /**
   * Resizes an image at the sourcePath to the given size and saves it to the destinationPath.
   * @param {string} sourcePath
   * @param {number} size
   * @param {string} destinationPath
   */
  async resizeImageTo(sourcePath: string, size: number, destinationPath: string) {
    if (size == null) { // if size is null, we do not resize just save it to the destination path
      await fs.promises.copyFile(sourcePath, destinationPath)
    }
    else {
      const newSize = await sharp(sourcePath)
        .rotate()
        .resize(size, size, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFile(destinationPath)
        .then(info => info.size)

      return newSize
    }
  }

  async handleFileUpload(file: Express.Multer.File) {
    const multerPath = file.path
    const type = file.mimetype
    const extension = file.originalname.split('.').pop()
    const filePath = `${file.filename}.${extension}` // the file will be saved with the extension attached

    await fs.promises.rename(multerPath, `${multerPath}.${extension}`)

    return RoboFileModel.create({
      name: file.originalname,
      path: filePath,
      size: file.size,
      extension,
      type,
    })
  }

  /** A helper function, that is a template for the CRUDS category routes. */
  async CRUDSRoute<T>({ req, res, operation, mainPart, responsePart }: {
    req: Request
    res: Response
    operation: OperationType
    mainPart: () => Promise<T>
    responsePart: (result: T) => Promise<void>
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
        .catch((err) => { throw new MiddlewareError('before', err) })

      const hasAccess = await this.hasModelAccess(req.params.model, mode, req)
      if (!hasAccess)
        return res.status(403).send()

      const result = await mainPart.call(this)

      await middlewareFunctions.after.call(this, req, res, result)
        .catch((err) => { throw new MiddlewareError('after', err) })

      await responsePart.call(this, result)
    }
    catch (err) {
      if (err instanceof MiddlewareError) {
        this.logger.logMiddlewareMessage(req.params.model, operation, err.type, err.message)
      }
      else {
        res.status(500).send(err)
        console.error(err)
      }
    }
  }

  async hasModelAccess(modelName: string, mode: AccessType, req: Request): Promise<boolean> {
    if (mode === 'read' && !req.checkReadAccess)
      return true
    if (mode === 'write' && !req.checkWriteAccess)
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
  async removeDeclinedFieldsFromObject({ object, mode, req, guardResults, ...params }: {
    object: Partial<MongooseDocument> | null
    mode: AccessType
    req: Request
    guardResults?: GuardResults
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
    guardResults = await this.calculateGuardResults({ req, fields: fieldsInObj, mode, calculatedGuardResults: guardResults })

    const promises = fieldsInObj.map(field => this.removeDeclinedFieldsFromObjectHelper({ object, req, field, mode, checkGroupAccess, guardResults }))
    await Promise.all(promises)
  }

  async removeDeclinedFieldsFromObjectHelper({ object, req, field, mode, checkGroupAccess, guardResults }: {
    object: Partial<MongooseDocument>
    mode: AccessType
    req: Request
    guardResults: GuardResults
    checkGroupAccess: boolean
    field: RoboField<AccessGroup>
  }) {
    const declined = await this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardResults })
    if (declined) {
      delete object[field.key]
    }
    else if (field.ref !== 'RoboFile' && field.subfields && (mode === 'read' || !field.ref)) { // we only recurse to the subobjects if reading, or when writing but the field is not a reference
      const fieldsOrModel = field.ref ? { modelName: field.ref } : { fields: field.subfields }

      if (Array.isArray(object[field.key])) {
        const promises = (object[field.key] as Array<object>).map(obj => this.removeDeclinedFieldsFromObject({ ...fieldsOrModel, object: obj, mode, req, guardResults }))
        await Promise.all(promises)
      }
      else {
        await this.removeDeclinedFieldsFromObject({ ...fieldsOrModel, object: object[field.key] as object, mode, req, guardResults })
      }
    }
  }

  /** Checks if there is minimal required access groups set for the model, of which every group is in the requests access groups */
  hasEveryNeededAccessGroup(modelName: string, mode: AccessType, accessGroups: AccessGroup[]) {
    if (!this.models[modelName].minimalRequriedAccessGroupSets![mode].length)
      return true
    else
      return this.models[modelName].minimalRequriedAccessGroupSets![mode].some(as => as.every(ag => accessGroups.includes(ag)))
  }

  /** Calculates a Map of every access guard function and their results, that appear on the given fields */
  async calculateGuardResults({ req, fields, mode, calculatedGuardResults = new Map() }: {
    req: Request
    fields: RoboField<AccessGroup>[]
    mode: AccessType
    calculatedGuardResults?: GuardResults
  }): Promise<GuardResults> {
    const guardType = this.guardTypes[mode]

    const newGuards = new Set<GuardFunction>()
    for (const field of fields) {
      for (const guard of field[guardType]) {
        if (!calculatedGuardResults.has(guard)) {
          newGuards.add(guard)
        }
      }
    }

    const promises = [...newGuards].map(g => promisify(g.call(this, req)))
    const res = await Promise.allSettled(promises)

    const newResults = new Map<GuardFunction, boolean>()
    for (const guard of newGuards) {
      const result = res.shift()!
      const guardValue = result.status === 'fulfilled' && result.value

      newResults.set(guard, guardValue)
    }

    return new Map([...calculatedGuardResults, ...newResults])
  }

  /** Checks if the given field is readable/writeable with the request */
  async isFieldDeclined({ req, field, mode, checkGroupAccess = true, guardResults = null }: {
    req: Request
    field: RoboField<AccessGroup>
    mode: AccessType
    checkGroupAccess?: boolean
    guardResults?: null | GuardResults
  }): Promise<boolean> {
    const shouldCheckAccess = mode === 'read' ? req.checkReadAccess : req.checkWriteAccess
    if (!shouldCheckAccess)
      return false

    if (checkGroupAccess) {
      const groupType = this.groupTypes[mode]
      if (!this.hasGroupAccess(field[groupType], req.accessGroups as AccessGroup[]))
        return true
    }

    return this.isFieldDecliendByGuards(req, field, mode, guardResults)
  }

  /** Checks if the field is declined by the guard functions defined on it. */
  async isFieldDecliendByGuards(
    req: Request,
    field: RoboField<AccessGroup>,
    mode: AccessType,
    guardResults: null | GuardResults = null,
  ): Promise<boolean> {
    const guardType = this.guardTypes[mode]
    if (!field[guardType].length)
      return false

    const promises = field[guardType].map(async (guard) => {
      if (guardResults && guardResults.has(guard))
        return guardResults.get(guard)!
      else
        return promisify(guard.call(this, req))
    })

    return Promise.all(promises)
      .then(res => res.some(r => !r))
      .catch(() => true)
  }

  /** Removes every field that are not readable/writeable with the provided request in every document. */
  async removeDeclinedFields({ documents, mode, req, ...params }: {
    documents: MongooseDocument[]
    mode: AccessType
    req: Request
  } & ({
    fields: RoboField<AccessGroup>[]
  } | {
    modelName: string
  })) {
    const fields = 'fields' in params ? params.fields : this.schemas[params.modelName]
    const guardResults = await this.calculateGuardResults({ req, fields, mode })

    const promises = documents.map(doc => this.removeDeclinedFieldsFromObject({ ...params, object: doc, mode, req, guardResults }))
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
          throw new Error('declined')
        else
          return value
      },
      groupVisitor: async (results) => {
        const conditions = results.filter(result => Object.keys(result).length)

        if (!conditions.length)
          throw new Error('empty')
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

      if (outerKey === '$and' || outerKey === '$or') {
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

  async getAccesses(modelName: string, req: Request): Promise<Accesses> {
    // first we check for read and write accesses on the model itself
    const [canReadModel, canWriteModel] = await Promise.all([
      this.hasModelAccess(modelName, 'read', req),
      this.hasModelAccess(modelName, 'write', req),
    ])

    const modelAccesses = {
      read: canReadModel,
      write: canWriteModel,
    }

    // then we check the fields
    const fieldAccesses: Accesses['fields'] = {}
    const promises = this.accessTypes.map(async (mode) => {
      if (!modelAccesses[mode])
        return

      const [skipGroupAccessCheck, guardResults] = await Promise.all([
        this.hasEveryNeededAccessGroup(modelName, mode, req.accessGroups as AccessGroup[]),
        this.calculateGuardResults({ req, fields: this.schemas[modelName], mode }),
      ])

      const promises = this.schemas[modelName].map(field => this.addFieldAccesses({ accesses: fieldAccesses, mode, field, req, checkGroupAccess: !skipGroupAccessCheck, guardResults }))
      await Promise.all(promises)
    })
    await Promise.all(promises)

    // at last we combine the results
    const canWriteAllRequiredFields = Object.keys(this.pathSchemas[modelName]).every(path => !this.pathSchemas[modelName][path].required || fieldAccesses[path]?.write)

    return {
      model: {
        ...modelAccesses,
        create: canWriteModel && canWriteAllRequiredFields,
      },
      fields: fieldAccesses,
    }
  }

  async addFieldAccesses({ mode, field, req, checkGroupAccess, guardResults, accesses = {}, prefix = '' }: {
    accesses: Record<string, Partial<Record<AccessType, boolean>>>
    mode: AccessType
    field: RoboField<AccessGroup>
    req: Request
    checkGroupAccess: boolean
    guardResults: GuardResults
    prefix?: string
  }) {
    const isDeclined = await this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardResults })
    if (isDeclined)
      return

    const absolutePath = prefix + field.key
    if (!accesses[absolutePath])
      accesses[absolutePath] = {}

    accesses[absolutePath][mode] = true

    if (field.subfields && !field.ref) {
      const subGuardResults = await this.calculateGuardResults({ req, fields: field.subfields, mode, calculatedGuardResults: guardResults })
      const promises = field.subfields.map(f => this.addFieldAccesses({ mode, field: f, req, checkGroupAccess, guardResults: subGuardResults, accesses, prefix: `${absolutePath}.` }))
      await Promise.all(promises)
    }
  }

  serviceRoute(req: Request, res: Response, paramsKey: 'body' | 'query') {
    if (!this.services[req.params.service]) {
      this.logger.logMissingService(req.params.service, `serving the route: '${req.method} ${req.path}'`)
      return res.status(500).send('MISSING SERVICE')
    }
    if (!this.services[req.params.service][req.params.fun]) {
      this.logger.logMissingServiceFunction(req.params.service, req.params.fun, `serving the route: '${req.method} ${req.path}'`)
      return res.status(500).send('MISSING SERVICE FUNCTION')
    }

    this.services[req.params.service][req.params.fun]
      .call(this, req, res, req[paramsKey])
      .then(result => res.send(result))
      .catch(error => res.status(500).send(error))
  }

  /** Removes every fields that cannot be read/written by the provided request. The fields parameter should always be a 'decycledSchema'. */
  async removeDeclinedFieldsFromSchema({ fields, req, mode, modelName, guardResults }: {
    fields: RoboField<AccessGroup>[]
    mode: AccessType
    req: Request
    modelName?: string
    guardResults?: GuardResults
  }) {
    if (!fields.length)
      return fields

    const checkGroupAccess = !modelName || !this.hasEveryNeededAccessGroup(modelName, mode, req.accessGroups as AccessGroup[])
    guardResults = await this.calculateGuardResults({ req, fields, mode, calculatedGuardResults: guardResults })

    const notDeclinedFields = await asyncFilter(fields, async field => !await this.isFieldDeclined({ req, field, mode, checkGroupAccess, guardResults }))
    const promises = notDeclinedFields.map(async (field) => {
      const fieldCopy = { ...field }

      if (fieldCopy.subfields)
        fieldCopy.subfields = await this.removeDeclinedFieldsFromSchema({ fields: fieldCopy.subfields, req, mode, guardResults, modelName: field.ref }) // IMPROVEMENT: we should pass the field.ref to the recursion, so it can optimize more, but it should be passed alongside the fields so we don't get into a infinite loop.

      return fieldCopy
    })

    return Promise.all(promises)
  }

  /** Generates all the routes of robogo and returns the express router. */
  generateRoutes(): Router {
    const router = express.Router()

    router.use((req, res, next) => {
      if (req.accessGroups === undefined)
        req.accessGroups = []

      if (req.checkReadAccess === undefined)
        req.checkReadAccess = this.checkAccess

      if (req.checkWriteAccess === undefined)
        req.checkWriteAccess = this.checkAccess

      next()
    })

    // CREATE routes
    router.post('/create/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'C',
        mainPart: async () => {
          if (req.checkWriteAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: req.body, mode: 'write', req })

          return this.mongooseConnection.model(req.params.model).create(req.body)
        },
        responsePart: async (result) => {
          if (req.checkReadAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: result.toObject(), mode: 'read', req }) // .toObject() is needed, because create returns an immutable object by default

          res.send(result)
        },
      })
    })
    // ----------------

    // READ routes
    // these routes will use "lean" so that results are not immutable
    router.get('/read/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'R',
        mainPart: async () => {
          const [filter, sort] = await Promise.all([
            this.processFilter(req),
            this.processSort(req),
          ])

          return this.mongooseConnection.model(req.params.model)
            .find(filter, req.query.projection)
            .sort(sort)
            .skip(Number(req.query.skip) || 0)
            .limit(Number(req.query.limit) || Infinity)
            .lean({ autopopulate: true, virtuals: true, getters: true })
        },
        responsePart: async (results) => {
          if (req.checkReadAccess)
            await this.removeDeclinedFields({ modelName: req.params.model, documents: results as MongooseDocument[], mode: 'read', req })

          res.send(results)
        },
      })
    })

    router.get('/get/:model/:id', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'R',
        mainPart: async () => {
          return this.mongooseConnection.model(req.params.model)
            .findOne({ _id: req.params.id }, req.query.projection)
            .lean({ autopopulate: true, virtuals: true, getters: true })
        },
        responsePart: async (result) => {
          if (req.checkReadAccess)
            await this.removeDeclinedFieldsFromObject({ modelName: req.params.model, object: result as MongooseDocument | null, mode: 'read', req })

          res.send(result)
        },
      })
    })
    // ----------------

    // UPDATE routes
    router.patch('/update/:model', (req, res) => {
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
        responsePart: async (result) => {
          res.send(result)
        },
      })
    })
    // ----------------

    // DELETE routes
    router.delete('/delete/:model/:id', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'D',
        mainPart: async () => {
          const accesses = await this.getAccesses(req.params.model, req)

          if (!accesses.model.write || Object.values(accesses.fields).some(({ write }) => !write))
            throw new Error('FORBIDDEN')

          return this.mongooseConnection.model(req.params.model)
            .deleteOne({ _id: req.params.id })
        },
        responsePart: async (result) => {
          res.send(result)
        },
      })
    })
    // ----------------

    // SERVICE routes
    router.post('/runner/:service/:fun', (req, res) => {
      this.serviceRoute(req, res, 'body')
    })

    router.get('/getter/:service/:fun', (req, res) => {
      this.serviceRoute(req, res, 'query')
    })
    // ----------------

    // FILE routes
    if (this.fileDir) {
      router.use(
        '/static',
        this.wrapExpressMiddleware(this.fileReadMiddleware),
        express.static(this.fileDir, { maxAge: this.maxFileCacheAge }),
      )
      router.use('/static', (req, res) => {
        res.status(404).send('NOT FOUND')
      })

      router.post(
        '/fileupload',
        this.wrapExpressMiddleware(this.fileUploadMiddleware),
        this.upload!.single('file'),
        async (req, res) => {
          try {
            const roboFile = req.file!.mimetype.startsWith('image')
              ? await this.handleImageUpload(req.file!)
              : await this.handleFileUpload(req.file!)

            res.send(roboFile)
          }
          catch (err) {
            res.status(500).send(err)
          }
        },
      )

      router.post(
        '/fileclone/:id',
        this.wrapExpressMiddleware(this.fileUploadMiddleware),
        async (req, res) => {
          try {
            const roboFile = await RoboFileModel.findOne({ _id: req.params.id }).lean<RoboFile>()
            if (!roboFile)
              throw new Error('UNKNOWN FILE')

            const realPath = path.resolve(this.fileDir!, roboFile.path)
            if (!realPath.startsWith(this.fileDir!))
              throw new Error('INVALID PATH')

            const copyRealPath = realPath.replace('.', '_copy.')
            if (fs.existsSync(realPath))
              await fs.promises.copyFile(realPath, copyRealPath)

            if (roboFile.thumbnailPath) {
              const thumbnailPath = path.resolve(this.fileDir!, roboFile.thumbnailPath)
              if (!thumbnailPath.startsWith(this.fileDir!))
                throw new Error('INVALID PATH')

              const copyThumbnailPath = thumbnailPath.replace('.', '_copy.')
              if (fs.existsSync(thumbnailPath))
                await fs.promises.copyFile(thumbnailPath, copyThumbnailPath)
            }

            const copy: Optional<RoboFile, '_id'> = { ...roboFile }
            delete copy._id
            copy.path = roboFile.path.replace('.', '_copy.')
            if (roboFile.thumbnailPath)
              copy.thumbnailPath = roboFile.thumbnailPath.replace('.', '_copy.')

            const file = await RoboFileModel.create(roboFile)
            res.send(file)
          }
          catch (err) {
            res.status(500).send(err)
          }
        },
      )

      router.delete(
        '/filedelete/:id',
        this.wrapExpressMiddleware(this.fileDeleteMiddleware),
        async (req, res) => {
          try {
            const file = await RoboFileModel.findOne({ _id: req.params.id }).lean()
            if (!file)
              throw new Error('UNKNOWN FILE')

            // Remove the file
            const realPath = path.resolve(this.fileDir!, file.path)
            if (!realPath.startsWith(this.fileDir!))
              throw new Error('INVALID PATH')

            if (fs.existsSync(realPath))
              await fs.promises.unlink(realPath)

            // Remove thumbnail
            if (file.thumbnailPath) {
              const thumbnailPath = path.resolve(this.fileDir!, file.thumbnailPath)
              if (!thumbnailPath.startsWith(this.fileDir!))
                throw new Error('INVALID PATH')

              if (fs.existsSync(thumbnailPath))
                await fs.promises.unlink(thumbnailPath)
            }

            await RoboFileModel.deleteOne({ _id: file._id })
            res.send()
          }
          catch (err) {
            res.status(400).send(err)
          }
        },
      )
    }
    // --------------

    // SPECIAL routes
    router.get('/model/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'S',
        mainPart: () => this.hasModelAccess(req.params.model, 'read', req),
        responsePart: async (hasAccess) => {
          if (!req.checkReadAccess || hasAccess)
            res.send({ ...this.models[req.params.model], model: req.params.model })
          else
            res.status(403).send()
        },
      })
    })

    router.get('/model', (req, res) => {
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

    router.get('/fields/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'S',
        mainPart: async () => this.decycledSchemas[req.params.model],
        responsePart: async (fields) => {
          if (req.checkReadAccess)
            fields = await this.removeDeclinedFieldsFromSchema({ fields, req, mode: 'read', modelName: req.params.model })

          res.send(fields)
        },
      })
    })

    router.get('/count/:model', (req, res) => {
      this.CRUDSRoute({
        req,
        res,
        operation: 'S',
        mainPart: async () => {
          const filter = await this.processFilter(req)

          return this.mongooseConnection.model(req.params.model)
            .countDocuments(filter)
        },
        responsePart: async (result) => {
          res.send(String(result))
        },
      })
    })

    router.get('/accessesGroups', (req, res) => {
      const result = Object.keys(this.accessGroups)
      res.send(result)
    })

    router.get('/accesses/:model', async (req, res) => {
      try {
        const accesses = await this.getAccesses(req.params.model, req)
        res.send(accesses)
      }
      catch (err) {
        res.status(500).send(err)
      }
    })

    return router
  }

  addMiddleware(modelName: string, operation: OperationType, timing: 'before', middlewareFunction: MiddlewareBeforeFunction): void
  addMiddleware(modelName: string, operation: OperationType, timing: 'after', middlewareFunction: MiddlewareAfterFunction): void
  addMiddleware(modelName: string, operation: OperationType, timing: MiddlewareTiming, middlewareFunction: MiddlewareAfterFunction | MiddlewareBeforeFunction) {
    const errorOccurrence = `adding the custom middleware '${modelName} -> ${operation} -> ${timing}'`

    if (!this.middlewares[modelName]) {
      this.logger.logMissingModel(modelName, errorOccurrence)
      throw new Error(`MISSING MODEL: ${modelName}`)
    }
    if (!this.operations.includes(operation)) {
      this.logger.logUnknownOperation(operation, errorOccurrence)
      throw new Error(`Middleware: Operation should be one of: ${this.operations}`)
    }
    if (!this.timings.includes(timing)) {
      this.logger.logUnknownTiming(timing, errorOccurrence)
      throw new Error(`Middleware: Timing should be one of: ${this.timings}`)
    }

    // @ts-expect-error The funtion overload ensures the correct types
    this.middlewares[modelName][operation][timing] = middlewareFunction
  }

  async generateTSDefintions({ type, output }: { type: 'backend' | 'frontend', output: string }) {
    const interfaces = Object.entries(this.schemas).map(([modelName, schema]) => this.generateTSDefinitionForSchema(modelName, schema))
    const definitions = interfaces.join('\n\n')

    await fs.promises.writeFile(output, definitions)
  }

  private generateTSDefinitionForSchema(modelName: string, schema: RoboField<AccessGroup>[]): string {
    const fields = this.generateTSDefinitionForObject(schema, 1)
    return `interface ${modelName} ${fields}`
  }

  private generateTSDefinitionForObject(fields: RoboField<AccessGroup>[], depth: number): string {
    const lines = ['{']

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

function promisify<T>(value: T): Promise<Awaited<T>> {
  if (value instanceof Promise)
    return value
  else
    return Promise.resolve(value)
}

async function asyncFilter<T>(array: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
  const promises = array.map(item => predicate(item))
  const results = await Promise.all(promises)

  return array.filter((item, index) => results[index])
}

function getIndentation(depth: number) {
  return '  '.repeat(depth)
}
