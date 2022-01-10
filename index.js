const express       = require('express')
const multer        = require('multer')
const sharp         = require('sharp')
const Fuse          = require('fuse.js')
const path          = require('path')
const fs            = require('fs')
const RoboFileModel = require('./schemas/RoboFile')
const Logger        = require('./utils/logger')

const Router = express.Router()

class Robogo {
  constructor({
    MongooseConnection = require('mongoose'),
    SchemaDir,
    ServiceDir = null,
    FileDir = null,
    ServeStaticPath = '/static',
    MaxFileCacheAge = 5000,
    MaxImageSize = 800,
    CreateThumbnail = false,
    MaxThumbnailSize = 200,
    CheckAccess = true,
    ShowErrors = true,
    ShowWarnings = true,
    ShowLogs = true,
  }) {
    this.MongooseConnection     = MongooseConnection
    this.BaseDBString           = String(MongooseConnection.connections[0]._connectionString)
    this.Schemas                = {[this.BaseDBString]: {}}
    this.PathSchemas            = {}
    this.DecycledSchemas        = {}
    this.RoboFileShema          = []
    this.ModelsHighestAccesses  = {}
    this.Services               = {}
    this.Middlewares            = {}
    this.Operations             = ['C', 'R', 'U', 'D', 'S']
    this.Timings                = ['after', 'before']
    this.SchemaDir              = SchemaDir
    this.ServiceDir             = ServiceDir
    this.FileDir                = FileDir
    this.ServeStaticPath        = ServeStaticPath
    this.MaxFileCacheAge        = MaxFileCacheAge
    this.MaxImageSize           = MaxImageSize
    this.CreateThumbnail        = CreateThumbnail
    this.MaxThumbnailSize       = MaxThumbnailSize
    this.CheckAccess            = CheckAccess
    this.Logger                 = new Logger({ShowErrors, ShowWarnings, ShowLogs})
    this.Upload                 = null

    if(FileDir)
      this.Upload = multer({dest: FileDir}) // multer will handle the saving of files, when one is uploaded

    // Imports every .js file from "ServiceDir" into the "Services" object
    if(ServiceDir) {
      for(const ServiceFile of fs.readdirSync(ServiceDir)) {
        if(!ServiceFile.endsWith('.js')) continue

        const ServiceName = ServiceFile.replace('.js', '')
        this.Services[ServiceName] = require(`${ServiceDir}/${ServiceFile}`)
      }
    }

    this.RoboFileShema = this.GenerateSchema(RoboFileModel)
    this.GenerateSchemas()
    this.GenerateDecycledSchemas()
    this.GeneratePathSchemas()
    this.CollectHighestAccessesOfModels()
  }


  /**
   * Imports every model from "SchemaDir" and creates a robogo schema for it.
   * Also creates default middlewares for them.
   * Finally it handles the references between the schemas.
   */
  GenerateSchemas() {
    for( let schemaFile of fs.readdirSync(this.SchemaDir) ) {
      if( !schemaFile.endsWith('.js') ) continue

      let model = require(`${this.SchemaDir}/${schemaFile}`)
      let modelName = model.modelName || model.default.modelName

      this.Schemas[this.BaseDBString][modelName] = this.GenerateSchema(model)
      this.Middlewares[modelName] = {
        C: { before: () => Promise.resolve(), after: () => Promise.resolve() },
        R: { before: () => Promise.resolve(), after: () => Promise.resolve() },
        U: { before: () => Promise.resolve(), after: () => Promise.resolve() },
        D: { before: () => Promise.resolve(), after: () => Promise.resolve() },
        S: { before: () => Promise.resolve(), after: () => Promise.resolve() },
      }
    }

    // Now every schema is ready, we can ref them in each other and check which one of them needs to be access checked when queried
    for(let DBString in this.Schemas)
      for(let modelName in this.Schemas[DBString])
        for(let field of this.Schemas[DBString][modelName])
          this.plugInFieldRef(field, modelName)
  }

  /**
   * Creates a robogo schema for a specific model.
   * @param {Object} model - A mongoose model
   */
  GenerateSchema(model) {
    const Paths = this.GetPaths(model.schema)
    let fields = []

    for(const FieldPath in Paths)
      this.GenerateObjFieldTree(fields, FieldPath, Paths[FieldPath], model.modelName)

    return fields
  }

  /**
   * Removes circular references from the schemas and saves this copy of them.
   * Theese are the schema types, that can be turned into JSON when needed.
   */
  GenerateDecycledSchemas() {
    for(let modelName in this.Schemas[this.BaseDBString]) {
      const DecycledSchema = this.CopySubfields({subfields: this.Schemas[this.BaseDBString][modelName]}) // We copy the top level of fields
      this.DecycledSchemas[modelName] = DecycledSchema.subfields // Theese new fields will be the top level of the decycled schema

      for(let field of this.DecycledSchemas[modelName])
        this.DecycleField(field)
    }
  }

  /**
   * Recursively copies the given fields and their subfields, until circular reference is detected
   * @param {Object} field - A robogo field descriptor
   * @param {Array} [refs=[]] - This parameter should be leaved empty
   */
  DecycleField(field, refs = []) {
    if(!field.subfields) return

    let refId = `${field.DBString}:${field.ref}`
    if(refs.includes(refId)) return field.subfields = [] // if a ref was already present once in one of the parent fields, we stop
    if(field.ref) refs.push(refId) // we collect the refs of the fields that we once saw

    this.CopySubfields(field)

    for(let f of field.subfields) // do the same process for every child field passing along the collected refs
      this.DecycleField(f, [...refs])
  }

  /**
   * Copies one level of the subfields of the given field descriptor
   * @param {Object} field - A robogo field descriptor
   */
  CopySubfields(field) {
    field.subfields = [...field.subfields] // copying the subfields array

    for(let i=0; i<field.subfields.length; ++i)
      field.subfields[i] = {...field.subfields[i]} // copying the descriptor object of the subfields

    return field
  }

  /**
   * Generates a PathSchema descriptor for every schema handled by robogo
   */
  GeneratePathSchemas() {
    for(let modelName in this.DecycledSchemas) {
      this.PathSchemas[modelName] = {}

      for(let field of this.DecycledSchemas[modelName])
        this.GeneratePathSchema(field, this.PathSchemas[modelName])
    }
  }

  /**
   * Recursively generates <FieldPath, Field> entries for the field given and its subfields.
   * @param {Object} field - A robogo field descriptor
   * @param {Object} acc - Generated entries will be stored in this object
   * @param {String} [prefix] - This parameter should be leaved empty
   */
  GeneratePathSchema(field, acc, prefix = '') {
    acc[`${prefix}${field.key}`] = field

    if(field.subfields)
      for(let f of field.subfields)
        this.GeneratePathSchema(f, acc, `${prefix}${field.key}.`)
  }

  /**
   * Calculates the highest read and write accesses for every model and saves it to this.ModelsHighestAccesses[modelName].
   */
  CollectHighestAccessesOfModels() {
    for(let modelName in this.DecycledSchemas) {
      this.ModelsHighestAccesses[modelName] = this.CollectHighestAccessesOfModel(modelName, {
        subfields: this.DecycledSchemas[modelName],
        minReadAccess: 0,
        minWriteAccess: 0,
      })
    }
  }

  /**
   * Recursively calculates the highest read and write accesses for a model.
   * @param {String} modelName - Name of the model
   * @param {Object} field - A robogo field descriptor
   */
  CollectHighestAccessesOfModel(modelName, field) {
    if(this.ModelsHighestAccesses[modelName]) // If this model was already calculated
      return this.ModelsHighestAccesses[modelName] // then we return that result

    if(!field.subfields || (field.ref && !field.autopopulate)) return { // if the field is a 'leaf' or it has subfields but it wont be populated, so we dont see those values, then we return our accesses
      read: field.minReadAccess,
      write: field.minWriteAccess,
    }

    let maxReadAccess = field.minReadAccess
    let maxWriteAccess = field.minWriteAccess
    let subModelName = field.ref || modelName
    let resOfSubfields = field.subfields.map( f => this.CollectHighestAccessesOfModel(subModelName, f) ) // we calculate the results of our subfields

    // we take the maximum of our accesses and the ones in our subfields
    for(let res of resOfSubfields) {
      if(res.read > maxReadAccess) maxReadAccess = res.read
      if(res.write > maxWriteAccess) maxWriteAccess = res.write
    }

    return {
      read: maxReadAccess,
      write: maxWriteAccess,
    }
  }

  /**
   * Returns the field paths of a model that are safe to be used with fuse.js.
   * @param {(String|Array)} schema
   * @param {Number} [maxDepth=Infinity]
   */
  GetSearchKeys(schema, maxDepth = Infinity) {
    if(typeof schema == 'string')
      schema = this.DecycledSchemas[schema] // if string was given, we get the schema descriptor

    let keys = []

    for(let field of schema)
      this.GenerateSearchKeys(field, keys, maxDepth)

    return keys
  }

  /**
   * Recursively collects the field paths of a field and its subfields that are safe to be used with fuse.js.
   * @param {Object} field - A robogo field descriptor
   * @param {Array} keys - Keys will be collected in this array
   * @param {Number} maxDepth
   * @param {*} [prefix] - This parameter should be leaved empty
   * @param {*} [depth] - This parameter should be leaved empty
   */
  GenerateSearchKeys(field, keys, maxDepth, prefix = '', depth = 0) {
    if(depth > maxDepth) return

    if(!['Object', 'Date'].some(t => field.type == t) && !field.subfields) // fuse.js can not handle values that are not strings or numbers, so we don't collect those keys.
      keys.push(`${prefix}${field.key}`)

    if(field.subfields)
      for(let f of field.subfields)
        this.GenerateSearchKeys(f, keys, maxDepth, `${prefix}${field.key}.`, depth+1)
  }

  /**
   * Recursively creates an object with entries of field path and mongoose field descriptors
   * @param {Object} schema - A mongoose schema
   * @param {Obejct} [acc] - This parameter should be leaved empty
   * @param {String} [prefix] - This parameter should be leaved empty
   */
  GetPaths(schema, acc = {}, prefix = '') {
    let joinedPaths = {...schema.paths, ...schema.subpaths} // both paths and subpaths can store fields of the schema

    for(let key in joinedPaths) {
      let field = joinedPaths[key]
      let prefixedKey = prefix + key

      acc[prefixedKey] = field

      if(field.schema)
        this.GetPaths(field.schema, acc, `${prefixedKey}.`)
    }

    return acc
  }

  /**
   * Takes the fieldPath given and step by step creates robogo field descriptors for them.
   * @param {Array} currentFieldLevel - Created field descriptors will be collected in this
   * @param {String} fieldPath - The "." separated path of the field in the mongoose schema
   * @param {Object} fieldDescriptor - The mongoose descriptor of the field
   */
  GenerateObjFieldTree(currentFieldLevel, fieldPath, fieldDescriptor, modelName) {
    let fieldKeys = fieldPath.split('.') // we have no information of the fields with theese keys, other then that they are Objects containign the field of the next step and possibly others
    let lastKey = fieldKeys.pop() // this is the field that we have information about from mongoose

    if( ['_id', '__v', '$'].some(s => lastKey == s) ) return // theese fields are not handled by robogo

    for(const fieldKey of fieldKeys) {
      // first we search for an already created field descriptor that is on the same level as the key
      let ind = 0
      while( ind < currentFieldLevel.length && currentFieldLevel[ind].key != fieldKey ) ind++

      // if we went through the whole level and found no descriptor, we create one
      if(ind == currentFieldLevel.length)
        currentFieldLevel.push({
          key: fieldKey,
          isArray: false,
          type: 'Object',
          required: false,
          name: fieldKey,
          description: null,
          minReadAccess: 0,
          minWriteAccess: 0,
          subfields: []
        })

      // we go one level deeper for the next key
      currentFieldLevel = currentFieldLevel[ind].subfields
    }
    // when every parent descriptor is created, we create the one we have information about from mongoose
    currentFieldLevel.push( this.GenerateSchemaField(lastKey, fieldDescriptor, modelName) )
  }

  /**
   * Creates a robogo field descriptor from a mongoose one.
   * @param {String} fieldKey
   * @param {Object} fieldDescriptor - A mongoose field descriptor
   */
  GenerateSchemaField(fieldKey, fieldDescriptor, modelName) {
    // we basically collect the information we know about the field
    let field = {
      key: fieldKey,
      isArray: fieldDescriptor.instance == 'Array',
      type: fieldDescriptor.instance,
      required: fieldDescriptor.options.required || false,
      name: fieldDescriptor.options.name || null,
      description: fieldDescriptor.options.description || null,
      minReadAccess: fieldDescriptor.options.minReadAccess || 0,
      minWriteAccess: fieldDescriptor.options.minWriteAccess || 0,
    }
    if(fieldDescriptor.options.marked) field.marked = true
    if(fieldDescriptor.options.hidden) field.hidden = true
    if(fieldDescriptor.options.ref) field.ref = fieldDescriptor.options.ref
    if(fieldDescriptor.options.enum) field.enum = fieldDescriptor.options.enum
    if(fieldDescriptor.options.autopopulate) field.autopopulate = fieldDescriptor.options.autopopulate
    if(fieldDescriptor.options.hasOwnProperty('default')) field.default = fieldDescriptor.options.default

    // if the field is an array we extract the informations of the type it holds
    if(field.isArray) {
      const Emb = fieldDescriptor.$embeddedSchemaType

      field.type = Emb.instance || 'Object'
      field.name = field.name || Emb.options.name || null
      field.description = field.description || Emb.options.description || null
      field.minReadAccess = Math.max(field.minReadAccess, (Emb.options.minReadAccess || 0))
      field.minWriteAccess = Math.max(field.minWriteAccess, (Emb.options.minWriteAccess || 0))

      if(!Emb.instance) field.subfields = []
      if(Emb.options.marked) field.marked = true
      if(Emb.options.hidden) field.hidden = true
      if(Emb.options.ref) field.ref = Emb.options.ref
      if(Emb.options.enum) field.enum = Emb.options.enum
      if(Emb.options.hasOwnProperty('default') && !field.default) field.default = Emb.options.default
      if(Emb.options.autopopulate) field.autopopulate = Emb.options.autopopulate
    }

    if(field.type == 'ObjectID') field.type = 'Object'
    else if(field.type == 'Embedded') {
      field.type = 'Object'
      field.subfields = []
    }
    // If a Mixed type is found we try to check if it was intentional or not
    // if not, then we warn the user about the possible danger
    // TODO: Find a better way to do this
    else if(field.type == 'Mixed') {
      let givenType = field.type
      field.type = 'Object'

      if(fieldDescriptor.options) {
        if(Array.isArray(fieldDescriptor.options.type)) {
          if(Object.keys(fieldDescriptor.options.type[0]).length)
            givenType = fieldDescriptor.options.type[0].schemaName || fieldDescriptor.options.type[0].type.schemaName
        }
        else {
          if(Object.keys(fieldDescriptor.options.type).length)
            givenType = fieldDescriptor.options.type.schemaName
        }
      }

      if(givenType != 'Mixed')
        this.Logger.LogMixedType(modelName, fieldKey, field)
    }

    // if the field has a ref, we check if it is a string or a model
    if(field.ref) {
      let givenRef = field.ref
      let isModel = typeof givenRef == 'function'

      field.DBString = isModel ? givenRef.db._connectionString : this.BaseDBString // we need to know which connection the ref model is from
      field.ref = isModel ? givenRef.modelName : givenRef

      // if the model is from another connection, we generate a schema descriptor for it, so we can later use it as ref
      if(field.DBString != this.BaseDBString) {
        if(!this.Schemas[field.DBString]) this.Schemas[field.DBString] = {}
        this.Schemas[field.DBString][field.ref] = this.GenerateSchema(givenRef)
      }
    }

    return field
  }

  /**
   * Recursively plugs in the references of the given field and its subfields.
   * @param {Object} field - A robogo field descriptor
   */
  plugInFieldRef(field, modelName) {
    if(!field.ref && !field.subfields) return

    if(field.ref) {
      if(field.ref == 'RoboFile') return field.subfields = this.RoboFileShema // RoboFile is not stored in the "Schemas" object as it comes from this library not the user.
      if(this.Schemas[field.DBString][field.ref]) return field.subfields = this.Schemas[field.DBString][field.ref] // If the ref is known as a schema, then the fields new subfields are the fields of that schema

      return this.Logger.LogUnknownReference(modelName, field.key, field.ref, `processing the field '${modelName} -> ${field.key}'`)
    }

    for(const fObj of field.subfields)
      this.plugInFieldRef(fObj)
  }

  /**
   * Collects the fields of a model, which need a higher accesslevel, then given as parameter.
   * @param {String} modelName
   * @param {Number} [accesslevel=0]
   * @param {String} [authField='minReadAccess'] - Either 'minReadAccess' or 'minWriteAccess'
   * @param {Boolean} [excludeSubKeys=false] - Indicates whether or not only top level fields should be checked
   */
  GetDeclinedPaths(modelName, accesslevel = 0, authField = 'minReadAccess', excludeSubKeys = false) {
      let fieldEntries = Object.entries(this.PathSchemas[modelName])

      if(excludeSubKeys) fieldEntries = fieldEntries.filter( ([key, field]) => !key.includes('.') )
      fieldEntries = fieldEntries.filter( ([key, field]) => field[authField] > accesslevel )

      return fieldEntries.map(entr => entr[0])
  }

  /**
   * Removes every field from an array of documents, which need a  higher accesslevel, then given as parameter.
   * @param {String} modelName
   * @param {Array} documents
   * @param {Number} [accesslevel=0]
   * @param {String} [authField='minReadAccess']
   */
  RemoveDeclinedFields(modelName, documents, accesslevel = 0, authField = 'minReadAccess') {
    for(const document of documents)
      this.RemoveDeclinedFieldsFromObject(modelName, document, accesslevel, authField)

    return documents
  }

  /**
   * Removes every field from an object, which need a higher accesslevel, then given as parameter.
   * @param {Array|String} fields - A robogo schema descriptor or a models name
   * @param {Object} object - The object to remove from
   * @param {Number} [accesslevel=0]
   * @param {String} [authField='minReadAccess']
   */
  RemoveDeclinedFieldsFromObject(fields, object, accesslevel = 0, authField = 'minReadAccess') {
    if(!object) return
    if(typeof fields == 'string') fields = this.Schemas[this.BaseDBString][fields] // if model name was given, then we get the models fields

    for(let field of fields) {
      if(field[authField] > accesslevel) delete object[field.key]

      else if(field.subfields && object[field.key]) {
        if(Array.isArray(object[field.key])) object[field.key].forEach( obj => this.RemoveDeclinedFieldsFromObject(field.subfields, obj, accesslevel, authField) )
        else this.RemoveDeclinedFieldsFromObject(field.subfields, object[field.key], accesslevel, authField)
      }
    }
  }

  /**
   * Removes every field from a schema descriptor, which have a higher minReadAccess then the given accesslevel.
   * @param {Array|String} fields - A robogo schema descriptor or a models name
   * @param {Number} [accesslevel=0]
   */
  RemoveDeclinedFieldsFromSchema(schema, accesslevel = 0) {
    if(typeof schema == 'string') schema = this.DecycledSchemas[schema] // if string was given, we get the schema descriptor

    let fields = []

    for(let field of schema) {
      if(field.minReadAccess > accesslevel) continue
      let newField = {...field}

      if(field.subfields)
        newField.subfields = this.RemoveDeclinedFieldsFromSchema(field.subfields, accesslevel)

      fields.push(newField)
    }

    return fields
  }

  /**
   * Recursively creates field descriptors that only have those information, which can be useful on the frontend.
   * This function does NOT check field access, if that is needed please provide the result of the RemoveDeclinedFieldsFromSchema call as the first parameter.
   * @param {(String|Array)} schema - Model name or robogo schema descriptor
   * @param {Number} [maxDepth=Infinity] - Maximum reference depth
   * @param {Number} [depth=0] - This parameter should be leaved empty
   */
  GetFields(schema, maxDepth = Infinity, depth = 0) {
    if(typeof schema == 'string')
      schema = (maxDepth == Infinity ? this.DecycledSchemas : this.Schemas[this.BaseDBString])[schema] // if string was given, we get the schema descriptor

    let fields = []

    for(let field of schema) {
      if(field.hidden) continue // fields marked as hidden should not be included in fields
      let fieldDescriptor = {}

      for(let key of ['name', 'key', 'description', 'type', 'isArray', 'marked']) // we copy theese fields as they are useful on the frontend
        fieldDescriptor[key] = field[key]

      // if current depth is lower then max, we collect the descriptors of the subfields
      if(field.subfields && depth < maxDepth)
        fieldDescriptor.subfields = this.GetFields(field.subfields, maxDepth, field.ref ? depth+1 : depth)

      fields.push(fieldDescriptor)
    }

    return fields
  }

  /**
   * Helper function, that is used when an image was uploaded.
   * It will resize the image to the specified size if needed.
   * It will create a RoboFile document for the image, with the properties of the image.
   * It will also create a thumbnail of the image if needed.
   * @param {Object} req
   * @param {Object} res
   */
  handleImageUpload(req, res) {
    let multerPath    = req.file.path
    let extension     = req.file.originalname.split('.').pop()
    let filePath      = `${req.file.filename}.${extension}` // the image will be saved with the extension attached

    let newSize = req.file.size // this will be overwritten with the size after the resizing
    this.resizeImageTo(multerPath, this.MaxImageSize, `${multerPath}.${extension}`) // resizes and copies the image
      .then( size => {
        if(size) // if 'this.MaxImageSize' is set to null, then no resizing was done (and 'size' is undefined)
          newSize = size

        if(this.CreateThumbnail) //if a thumbnail is needed create one
          return this.resizeImageTo(multerPath, this.MaxThumbnailSize, `${multerPath}_thumbnail.${extension}`)
      })
      .then( () => fs.promises.unlink(multerPath) ) // we don't need the original image anymore
      .then( () => RoboFileModel.create({ // we create the RoboFile document
        name: req.file.originalname,
        path: filePath,
        size: newSize,
        extension: extension,
        isImage: true,
        ...this.CreateThumbnail && {thumbnailPath: `${req.file.filename}_thumbnail.${extension}`} // A hacky way of only append thumbnailPath to an object, when CreateThumbnail is true
      }))
      .then( file => res.send(file) )
      .catch( err => {
        console.error(err)
        res.status(500).send(err)
      })
  }

  /**
   * Resizes an image at the sourcePath to the given size and saves it to the destinationPath.
   * @param {String} sourcePath
   * @param {Number} size
   * @param {String} destinationPath
   */
  resizeImageTo(sourcePath, size, destinationPath) {
    if(size == null) return fs.promises.copyFile(sourcePath, destinationPath) // if size is null, we do not resize just save it to the destination path

    return new Promise( (resolve, reject) => {
      sharp(sourcePath)
        .resize(size, size, {
          fit: 'inside',
          withoutEnlargement: true, // if the size was already smaller then specified, we do not enlarge it
        })
        .toFile(destinationPath, (err, info) => {
          if(err) reject(err)
          else resolve(info.size)
        })
    })
  }

  /**
   * Adds a middleware function to the given model.
   * @param {String} modelName
   * @param {String} operation
   * @param {String} timing
   * @param {Function} middlewareFunction
   */
  addMiddleware(modelName, operation, timing, middlewareFunction) {
    let errorOccurrence =  `adding the custom middleware '${modelName} -> ${operation} -> ${timing}'`

    if(!this.Middlewares[modelName]) {
      this.Logger.LogMissingModel(modelName, errorOccurrence)
      throw new Error(`MISSING MODEL: ${modelName}`)
    }
    if(!this.Operations.includes(operation)) {
      this.Logger.LogUnknownOperation(operation,  errorOccurrence)
      throw new Error(`Middleware: Operation should be one of: ${this.Operations}`)
    }
    if(!this.Timings.includes(timing)) {
      this.Logger.LogUnknownTiming(timing,  errorOccurrence)
      throw new Error(`Middleware: Timing should be one of: ${this.Timings}`)
    }

    this.Middlewares[modelName][operation][timing] = middlewareFunction
  }

  /**
   * A helper function, that is a template for the CRUDS category routes.
   * @param {Object} req
   * @param {Object} res
   * @param {Function} mainPart
   * @param {Function} responsePart
   * @param {String} operation
   */
  CRUDSRoute(req, res, mainPart, responsePart, operation) {
    // if the model is unkown send an error
    if(!this.Schemas[this.BaseDBString][req.params.model]) {
      this.Logger.LogMissingModel(req.params.model, `serving the route: '${req.method} ${req.path}'`)
      return res.status(500).send('MISSING MODEL')
    }

    // the code below calls the middleware and normal parts of the route and handles their errors correspondingly
    const MiddlewareFunctions = this.Middlewares[req.params.model][operation]
    MiddlewareFunctions.before.call(this, req, res)
      .then( () => {
        mainPart.call(this, req, res)
          .then( result => {
            MiddlewareFunctions.after.call(this, req, res, result)
              .then( () => {
                responsePart.call(this, req, res, result)
                  .catch( err => {res.status(500).send(err); console.error(err)} )
              })
              .catch( message => this.Logger.LogMiddlewareMessage(req.params.model, operation, 'after', message) )
          })
          .catch( err => {res.status(500).send(err); console.error(err)} )
      })
      .catch( message => this.Logger.LogMiddlewareMessage(req.params.model, operation, 'before', message) )
  }

  /**
   * A helper function, that is a template for Service routes.
   * @param {Obejct} req
   * @param {Object} res
   * @param {String} paramsKey
   */
  ServiceRoute(req, res, paramsKey) {
    if(!this.Services[req.params.service]) {
      this.Logger.LogMissingService(req.params.service, `serving the route: '${req.method} ${req.path}'`)
      return res.status(500).send('MISSING SERVICE')
    }
    if(!this.Services[req.params.service][req.params.fun]) {
      this.Logger.LogMissingServiceFunction(req.params.service, req.params.fun, `serving the route: '${req.method} ${req.path}'`)
      return res.status(500).send('MISSING SERVICE FUNCTION')
    }

    this.Services[req.params.service][req.params.fun]
      .call( this, req, res, req[paramsKey] )
      .then( result => res.send(result) )
      .catch( error => res.status(500).send(error) )
  }

  /**
   * Generates all the routes of robogo and returns the express router.
   */
  GenerateRoutes() {
    // Middleware that adds default values to robogo properties if they were not specified
    Router.use( (req, _, next) => {
      if(req.accesslevel === undefined)
        req.accesslevel = 0

      if(req.checkAccess === undefined)
        req.checkAccess = this.CheckAccess

      next()
    })
    // CREATE routes
    Router.post( '/create/:model', (req, res) => {
      function mainPart(req, res) {
        let checkWriteAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].write > req.accesslevel

        if(checkWriteAccess)
          this.RemoveDeclinedFieldsFromObject(req.params.model, req.body, req.accesslevel, 'minWriteAccess')

        const Model = this.MongooseConnection.model(req.params.model)
        const ModelInstance = new Model(req.body)
        return ModelInstance.save()
      }

      async function responsePart(req, res, result) {
        result = result.toObject() // this is needed, because mongoose returns an immutable object by default
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel

        if(checkReadAccess)
          this.RemoveDeclinedFieldsFromObject(req.params.model, result, req.accesslevel)

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'C')
    })
    // ----------------

    // READ routes
    // these routes will use "lean" so that results are not immutable
    Router.get( '/read/:model', (req, res) => {
      function mainPart(req, res) {
        return this.MongooseConnection.model(req.params.model)
        .find( JSON.parse(req.query.filter || '{}'), req.query.projection )
        .lean({ autopopulate: true, virtuals: true, getters: true })
        .sort( JSON.parse(req.query.sort || '{}') )
        .skip( Number(req.query.skip) || 0 )
        .limit( Number(req.query.limit) || null )
      }

      async function responsePart(req, res, results) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel

        if(checkReadAccess)
          this.RemoveDeclinedFields(req.params.model, results, req.accesslevel)

        res.send(results)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })

    Router.get( '/get/:model/:id', (req, res) => {
      function mainPart(req, res) {
        return this.MongooseConnection.model(req.params.model)
        .findOne({_id: req.params.id}, req.query.projection)
        .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, result) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel

        if(checkReadAccess)
          this.RemoveDeclinedFieldsFromObject(req.params.model, result, req.accesslevel)

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })

    Router.get( '/search/:model', (req, res) => {
      function mainPart(req, res) {
        return this.MongooseConnection.model(req.params.model)
        .find( JSON.parse(req.query.filter || '{}'), req.query.projection )
        .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, results) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel

        if(checkReadAccess)
          this.RemoveDeclinedFields(req.params.model, results, req.accesslevel)

        if(!req.query.threshold)
          req.query.threshold = 0.4
        if(!req.query.term)
          return res.send(results)
        if(!req.query.keys || req.query.keys.length == 0) { // if keys were not given, we search in all keys
          let schema = this.DecycledSchemas[req.params.model]

          if(checkReadAccess)
            schema = this.RemoveDeclinedFieldsFromSchema(schema, req.accesslevel)

          req.query.keys = this.GetSearchKeys(schema, req.query.depth)
        }

        const fuse = new Fuse(results, {
          includeScore: false,
          keys: req.query.keys,
          threshold: req.query.threshold
        })

        let matched = fuse.search(req.query.term).map(r => r.item) // fuse.js's results include some other things, then the documents so we need to get them
        res.send(matched)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })
    // ----------------

    // UPDATE routes
    Router.patch( '/update/:model', (req, res) => {
      function mainPart(req, res) {
        let checkWriteAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].write > req.accesslevel

        if(checkWriteAccess)
          this.RemoveDeclinedFieldsFromObject(req.params.model, req.body, req.accesslevel, 'minWriteAccess')

        return this.MongooseConnection.model(req.params.model)
          .updateOne({ _id: req.body._id }, req.body)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'U')
    })
    // ----------------

    // DELETE routes
    Router.delete( '/delete/:model/:id', (req, res) => {
      function mainPart(req, res) {
        let checkWriteAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].write > req.accesslevel

        if(checkWriteAccess) {
          const declinedPaths = this.GetDeclinedPaths(req.params.model, req.accesslevel, 'minWriteAccess', true)
          if(declinedPaths.length) return Promise.reject('PERMISSION DENIED')
        }

        return this.MongooseConnection.model(req.params.model)
        .deleteOne({ _id: req.params.id })
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'D')
    })
    // ----------------

    // SERVICE routes
    Router.post( '/runner/:service/:fun', (req, res) => {
      this.ServiceRoute(req, res, 'body')
    })

    Router.get( '/getter/:service/:fun', (req, res) => {
      this.ServiceRoute(req, res, 'query')
    })
    // ----------------

    // FILE routes
    if(this.FileDir) {
      Router.use( `${this.ServeStaticPath}`, express.static(path.resolve(__dirname, this.FileDir), {maxAge: this.MaxFileCacheAge}) )
      Router.use( `${this.ServeStaticPath}`, (req, res) => res.status(404).send('NOT FOUND') ) // If a file is not found in FileDir, send back 404 NOT FOUND

      Router.post( '/fileupload', this.Upload.single('file'), (req, res) => {
        if(req.file.mimetype.startsWith('image')) return this.handleImageUpload(req, res)

        let multerPath    = req.file.path
        let extension     = req.file.originalname.split('.').pop()
        let filePath      = `${req.file.filename}.${extension}` // the file will be saved with the extension attached

        fs.renameSync(multerPath, `${multerPath}.${extension}`)

        let fileData = {
          name: req.file.originalname,
          path: filePath,
          size: req.file.size,
          extension: extension,
        }

        // we create the RoboFile document with the properties of the file
        RoboFileModel.create(fileData, (err, file) => {
          if(err) res.status(500).send(err)
          else res.send(file)
        })
      })

      Router.delete( '/filedelete/:id', (req, res) => {
        RoboFileModel.findOne({_id: req.params.id})
          .then( file => {
            let realPath = path.resolve(this.FileDir, file.path)
            let thumbnailPath = realPath.replace('.', '_thumbnail.')
            if(!realPath.startsWith(this.FileDir)) return res.status(500).send('INVALID PATH') // for safety, if the resolved path is outside of FileDir we return 500 INVALID PATH

            // we remove both the file and thumbnail if they exists
            if(fs.existsSync(realPath)) fs.unlinkSync(realPath)
            if(fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath)

            // we delete the RoboFile document
            return RoboFileModel.deleteOne({_id: file._id})
          })
          .then( () => res.send() )
          .catch( err => res.status(500).send(err) )
      })
    }
    // --------------

    // SPECIAL routes
    Router.get( '/schema/:model', (req, res) => {
      function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]
        return Promise.resolve(schema)
      }

      async function responsePart(req, res, result) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel

        if(checkReadAccess)
          result = this.RemoveDeclinedFieldsFromSchema(result, req.accesslevel)

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/fields/:model', (req, res) => {
      function mainPart(req, res) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel
        let schema = this.DecycledSchemas[req.params.model]

        if(checkReadAccess)
          schema = this.RemoveDeclinedFieldsFromSchema(schema, req.accesslevel)

        let fields = this.GetFields(schema, req.query.depth)
        return Promise.resolve(fields)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/count/:model', (req, res) => {
      function mainPart(req, res) {
        if(!req.query.filter) req.query.filter = '{}'

        return this.MongooseConnection.model(req.params.model)
          .countDocuments(JSON.parse(req.query.filter))
      }

      async function responsePart(req, res, result) {
        res.send(String(result))
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/searchkeys/:model', (req, res) => {
      function mainPart(req, res) {
        let checkReadAccess = req.checkAccess && this.ModelsHighestAccesses[req.params.model].read > req.accesslevel
        let schema = this.DecycledSchemas[req.params.model]

        if(checkReadAccess)
          schema = this.RemoveDeclinedFieldsFromSchema(schema, req.accesslevel)

        let keys = this.GetSearchKeys(schema, req.query.depth)
        return Promise.resolve(keys)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })
    // ------------

    return Router
  }
}

module.exports = Robogo
