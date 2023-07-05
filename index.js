const mongoose      = require('mongoose')
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
    MongooseConnection = mongoose,
    SchemaDir,
    ServiceDir = null,
    FileDir = null,
    ServeStaticPath = '/static',
    MaxFileCacheAge = 5000,
    MaxImageSize = 800,
    CreateThumbnail = false,
    MaxThumbnailSize = 200,
    CheckAccess = true,
    Softwares = [],
    AccessGroups = {},
    AdminGroups = null,
    ShowErrors = true,
    ShowWarnings = true,
    ShowLogs = true,
  }) {
    this.MongooseConnection     = MongooseConnection
    this.BaseDBString           = String(MongooseConnection.connections[0]._connectionString)
    this.Models                 = {}
    this.Schemas                = {[this.BaseDBString]: {}}
    this.PathSchemas            = {}
    this.DecycledSchemas        = {}
    this.RoboFileShema          = []
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
    this.GroupTypes             = {read: 'readGroups', write: 'writeGroups'}
    this.GuardTypes             = {read: 'readGuards', write: 'writeGuards'}
    this.Softwares              = Softwares
    this.AdminGroups            = AdminGroups

    if(Array.isArray(AccessGroups)) {
      this.AccessGroups = {}
      
      for(let group of AccessGroups) {
        this.AccessGroups[group] = []
      }
    }
    else {
      this.AccessGroups = AccessGroups
    }

    for(let group in this.AccessGroups) {
      for(let software of this.AccessGroups[group]) {
        if(!this.Softwares.includes(software)) {
          this.Logger.LogUnknownSoftwareInAccessGroup(group, software, `processing the access group '${group}'`)
        }
      }
    }

    this.RoboFileShema = this.GenerateSchema(RoboFileModel)
    this.GenerateSchemas()
    this.GenerateDecycledSchemas()
    this.GeneratePathSchemas()
    this.CollectHighestAccessesOfModels()

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
  }


  /**
   * Imports every model from "SchemaDir" and creates a robogo schema for it.
   * Also creates default middlewares for them.
   * Finally it handles the references between the schemas.
   */
  GenerateSchemas() {
    for(let schemaPath of this._GetFilesRecursievely(this.SchemaDir).flat(Infinity)) {
      if(!schemaPath.endsWith('.js')) continue

      let model = require(schemaPath)
      let modelName = model.modelName || model.default.modelName

      this.Models[modelName] = {
        model,
        name: model.schema.options.name,
        softwares: model.schema.options.softwares || [],
        props: model.schema.options.props || {},
        highestAccesses: null,
        readGuards: model.schema.options.readGuards || [],
        writeGuards: model.schema.options.writeGuards || [],
        defaultFilter: model.schema.options.defaultFilter || {},
        defaultSort: this.ObjectifySortValue(model.schema.options.defaultSort || {}),
      }

      for(let software of this.Models[modelName].softwares) {
        if(!this.Softwares.includes(software)) {
          this.Logger.LogUnknownSoftwareInModel(modelName, software, `processing the model '${modelName}'`)
        }
      }

      for(let groupType of Object.values(this.GroupTypes)) {
        if(!model.schema.options[groupType]) continue

        this.Models[modelName][groupType] = model.schema.options[groupType]

        // we add the 'AdminGroups' to the accessGroups if it was not empty
        if(this.AdminGroups) {
          if(Array.isArray(this.AdminGroups)) 
            this.Models[modelName][groupType].unshift(...this.AdminGroups)
          
          else if(typeof this.AdminGroups == 'object') {
            for(let software of this.Models[modelName].softwares) {
              if(!this.AdminGroups[software]) continue

              this.Models[modelName][groupType].unshift(...this.AdminGroups[software])
            }
          }

          else 
            this.Logger.LogIncorrectAdminGroups(this.AdminGroups, `processing the admin groups of the model '${modelName}'`) 
        }

        // We check if an access group is used, that was not provided in the constructor,
        // if so we warn the developer, because it might be a typo.
        for(let group of this.Models[modelName][groupType]) {
          if(!this.AccessGroups[group]) {
            this.Logger.LogUnknownAccessGroupInModel(modelName, group, `processing the model '${modelName}'`)
          }
          else if(
            this.AccessGroups[group].length && this.Models[modelName].softwares.length &&
            !this.AccessGroups[group].some(software => this.Models[modelName].softwares.includes(software))
          ) {
            this.Logger.LogIncorrectAccessGroupSoftwareInModel(modelName, group, this.AccessGroups[group], this.Models[modelName].softwares, `processing the model '${modelName}'`)
          }
        }
      }

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

  ObjectifySortValue(sortValue) {
    if(Array.isArray(sortValue))
      return Object.fromEntries([sortValue]) // TODO: find out why this extra array is needed (why the originally sent [[]] arrives as [])

    if(typeof sortValue === 'object')
      return sortValue

    // else its a string (https://mongoosejs.com/docs/api/query.html#Query.prototype.sort())
    const sortObj = {}
    const entries = sortValue.split(' ')
    for(const entry of entries) {
      const isDesc = entry[0] === '-'

      if(isDesc)
        sortObj[entry.slice(1)] = -1
      else
        sortObj[entry] = 1
    }

    return sortObj
  }

  _GetFilesRecursievely(rootPath) {
    let entries = fs.readdirSync(rootPath, {withFileTypes: true})

    return entries.map( entry => {
      let entryPath = path.join(rootPath, entry.name)

      if(entry.isDirectory()) return this._GetFilesRecursievely(entryPath)
      else return entryPath
    })
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
   * Calculates the highest read and write accesses for every model and saves it to this.Models[DBString][modelName].highestAccesses
   */
  CollectHighestAccessesOfModels() {
    for(let modelName in this.DecycledSchemas) {
      let accessesOfModel = this.CollectHighestAccessesOfModel(modelName, {
        subfields: this.DecycledSchemas[modelName],
        readGroups: [],
        writeGroups: [],
        ref: modelName,
      })

      this.Models[modelName].highestAccesses = {
        read: accessesOfModel.read.map(ag => {ag.delete(null); return [...ag]}),
        write: accessesOfModel.write.map(ag => {ag.delete(null); return [...ag]})
      }
    }
  }

  /**
   * Recursively calculates the highest read and write accesses for a model.
   * @param {String} modelName - Name of the model
   * @param {Object} field - A robogo field descriptor
   */
  CollectHighestAccessesOfModel(modelName, field) {
    if(modelName && this.Models[modelName].highestAccesses) // If this model was already calculated
      return this.Models[modelName].highestAccesses // then we return that result

    if(!field.subfields || field.ref == 'RoboFile') return { // if the field is a 'leaf' then we return our accesses
      read: field.readGroups ? field.readGroups.map(a => new Set([a])) : [],
      write: field.writeGroups ? field.writeGroups.map(a => new Set([a])) : [],
    }

    let resOfSubfields = field.subfields.map( f => this.CollectHighestAccessesOfModel(field.ref, f) ) // we calculate the results of our subfields

    // we collect all the combinations of the needed access groups into an object
    let fieldReadGroups = field.readGroups ? field.readGroups.map(a => new Set([a])) : []
    this.mergeChildAccessGroups(fieldReadGroups, resOfSubfields, 'read')

    let fieldWriteGroups = field.writeGroups ? field.writeGroups.map(a => new Set([a])) : []
    this.mergeChildAccessGroups(fieldWriteGroups, resOfSubfields, 'write')

    return {
      read: fieldReadGroups,
      write: fieldWriteGroups,
    }
  }

  mergeChildAccessGroups(fieldGroups, resOfSubfields, mode) {
    if(!fieldGroups.length)
      fieldGroups.push(new Set([null]))

    for(let [index, nodeAccess] of fieldGroups.entries()) { // a node read access-ei
      for(let child of resOfSubfields) { // childen's results
        if(child[mode].some(g => [...g].every(a => nodeAccess.has(a)))) continue

        let copysNeeded = child[mode].length-1
        for(let i = 0; i < copysNeeded; ++i) {
          fieldGroups.splice(index, 0, new Set(nodeAccess))
        }

        for(let [ind, accessGroup] of child[mode].entries()) { // access groups of child
          let target = fieldGroups[index+ind]
          accessGroup.forEach(target.add, target)
        }
      }
    }

    fieldGroups.sort((a, b) => a.size - b.size)
    this.removeDuplicateSetsFromArray(fieldGroups)
  }

  removeDuplicateSetsFromArray(array) {
    for(let i = 0; i < array.length; ++i) {
      for(let j = i+1; j < array.length; ++j) {
        if([...array[i]].every(a => array[j].has(a))) {
          array.splice(j, 1)
          --j
        }
      }
    }
  }

  /**
   * Returns the field paths of a model that are safe to be used with fuse.js. JSDoc
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
   * @param {Object} [acc] - This parameter should be leaved empty
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
    const softDeletedOn = fieldDescriptor.options.softDelete
    if(softDeletedOn !== undefined)
      this.Models[modelName].defaultFilter[fieldKey] = {$ne: softDeletedOn}

    let field = {
      key: fieldKey,
      isArray: fieldDescriptor.instance == 'Array',
      type: fieldDescriptor.instance,
      required: fieldDescriptor.options.required || false,
      name: fieldDescriptor.options.name || null,
      description: fieldDescriptor.options.description || null,
      props: fieldDescriptor.options.props || {},
      readGuards: fieldDescriptor.options.readGuards || [],
      writeGuards: fieldDescriptor.options.writeGuards || [],
    }
    if(fieldDescriptor.options.marked) field.marked = true
    if(fieldDescriptor.options.hidden) field.hidden = true
    if(fieldDescriptor.options.ref) field.ref = fieldDescriptor.options.ref
    if(fieldDescriptor.options.enum) field.enum = fieldDescriptor.options.enum
    if(fieldDescriptor.options.autopopulate) field.autopopulate = fieldDescriptor.options.autopopulate
    if(fieldDescriptor.options.hasOwnProperty('default')) field.default = fieldDescriptor.options.default
    if(fieldDescriptor.options.readGroups) field.readGroups = fieldDescriptor.options.readGroups
    if(fieldDescriptor.options.writeGroups) field.writeGroups = fieldDescriptor.options.writeGroups

    // if the field is an array we extract the informations of the type it holds
    if(field.isArray) {
      const Emb = fieldDescriptor.$embeddedSchemaType

      field.type = Emb.instance || 'Object'
      field.name = field.name || Emb.options.name || null
      field.description = field.description || Emb.options.description || null
      field.props = field.props || Emb.options.props || {}
      field.readGuards = [...(field.readGuards || []), ...(Emb.options.readGuards || [])] // collecting all access groups without duplication
      field.writeGuards = [...(field.writeGuards || []), ...(Emb.options.writeGuards || [])] // collecting all access groups without duplication

      if(!Emb.instance) field.subfields = []
      if(Emb.options.marked) field.marked = true
      if(Emb.options.hidden) field.hidden = true
      if(Emb.options.ref) field.ref = Emb.options.ref
      if(Emb.options.enum) field.enum = Emb.options.enum
      if(Emb.options.hasOwnProperty('default') && !field.default) field.default = Emb.options.default
      if(Emb.options.autopopulate) field.autopopulate = Emb.options.autopopulate
      if(Emb.options.readGroups) field.readGroups = [...new Set([...(field.readGroups || []), ...(Emb.options.readGroups || [])])] // collecting all access groups without duplication
      if(Emb.options.writeGroups) field.writeGroups = [...new Set([...(field.writeGroups || []), ...(Emb.options.writeGroups || [])])] // collecting all access groups without duplication
    }

    for(let groupType of Object.values(this.GroupTypes)) {
      if(!field[groupType]) continue

      // we add the 'AdminGroups' to the accessGroups if it was not empty
      if(this.AdminGroups) {
        if(Array.isArray(this.AdminGroups)) 
          field[groupType].unshift(...this.AdminGroups)
        
        else if(typeof this.AdminGroups == 'object') {
          for(let software of this.Models[modelName].softwares) {
            if(!this.AdminGroups[software]) continue

            field[groupType].unshift(...this.AdminGroups[software])
          }
        }

        else 
          this.Logger.LogIncorrectAdminGroups(this.AdminGroups, `processing the admin groups of the field '${modelName} -> ${field.key}'`) 
      }


      // We check if an access group is used, that was not provided in the constructor,
      // if so we warn the developer, because it might be a typo.
      for(let group of field[groupType]) {
        if(!this.AccessGroups[group]) {
          this.Logger.LogUnknownAccessGroupInField(modelName, field.key, group, `processing the field '${modelName} -> ${field.key}'`)
        }
        else if(
          this.AccessGroups[group].length && this.Models[modelName].softwares.length &&
          !this.AccessGroups[group].some(software => this.Models[modelName].softwares.includes(software))
        ) {
          this.Logger.LogIncorrectAccessGroupSoftwareInField(modelName, field.key, group, this.AccessGroups[group], this.Models[modelName].softwares, `processing the field '${modelName} -> ${field.key}'`)
        }
      }
    }

    if(field.type == 'ObjectID') field.type = 'Object'
    else if(field.type == 'Embedded') {
      field.type = 'Object'
      field.subfields = []
    }
    // If a Mixed type is found we try to check if it was intentional or not
    // if not, then we warn the user about the possible error
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
      this.plugInFieldRef(fObj, field.ref || modelName)
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
    let type          = req.file.mimetype
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
        type,
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
        .rotate()
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
      return res.status(400).send('MISSING MODEL')
    }

    let mode = 'read'
    switch(operation) {
      case 'C': mode = 'write'; break;
      case 'U': mode = 'write'; break;
      case 'D': mode = 'write'; break;
    }

    // the code below calls the middleware and normal parts of the route and handles their errors correspondingly
    const MiddlewareFunctions = this.Middlewares[req.params.model][operation]
    MiddlewareFunctions.before.call(this, req, res)
      .then( () => {
        this.HasModelAccess(req.params.model, mode, req)
          .then( hasAccess => {
            if(!hasAccess) return res.status(403).send()

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
      })
      .catch( message => this.Logger.LogMiddlewareMessage(req.params.model, operation, 'before', message) )
  }

  HasModelAccess(model, mode, req) {
    let groupType = this.GroupTypes[mode]

    if(mode == 'read' && !req.checkReadAccess)
      return Promise.resolve(true)
    if(mode == 'write' && !req.checkWriteAccess)
      return Promise.resolve(true)

    if(!this.HasGroupAccess(this.Models[model][groupType], req.accessGroups)) {
      return Promise.resolve(false)
    }

    if(this.Models[model].accessGuards) {
      let promises = this.Models[model].accessGuards.map(guard => Promisify(guard(req)))
      return Promise.all(promises)
        .then( res => !res.some(r => !r) )
    }

    return Promise.resolve(true)
  }


  /**
   * Checks if the two given arrays have an intersection or not.
   * @param {Array<String>} goodGroups
   * @param {Array<String>} accessGroups
   * @returns boolean
   */
  HasGroupAccess(goodGroups, accessGroups) {
    return !goodGroups || goodGroups.some(gg => accessGroups.includes(gg))
  }

  /**
   * Removes every field from an array of documents, which need an access group not included in then given parameter.
   * @param {String|Array} fields
   * @param {Array} documents
   * @param {String} mode
   * @param {Object} req
   * @param {String} [DBString=this.BaseDBString]
   */
  async RemoveDeclinedFields(fields, documents, mode, req, DBString = this.BaseDBString) {
    let model = null
    if(typeof fields == 'string') { // if model name was given, then we get the models fields
      model = fields
      fields = this.Schemas[DBString][model]
    }

    let guardPreCache = await this.calculateGuardPreCache(req, fields, mode)
    let promises = documents.map(doc => this.RemoveDeclinedFieldsFromObject({fields, object: doc, mode, req, guardPreCache}))

    return Promise.all(promises)
  }

  /**
   * Removes declined fields from an object.
   * @async
   * @param {Object} params
   * @param {Array|String} params.fields
   * @param {Object} params.object
   * @param {String} params.mode
   * @param {Object} params.req
   * @param {String} [params.DBString=this.BaseDBString]
   * @param {Map?} [params.guardPreCache=null]
   * @returns {Promise}
   */
  async RemoveDeclinedFieldsFromObject({fields, object, mode, req, DBString = this.BaseDBString, guardPreCache = null}) { // todo update everywhere to obejct params
    if(!object) return Promise.resolve(object)

    let model = null
    if(typeof fields == 'string') { // if model name was given, then we get the models fields
      model = fields
      fields = this.Schemas[DBString][model]
    }

    let fieldsInObj = fields.filter(field => object.hasOwnProperty(field.key))
    if(!fieldsInObj.length) return Promise.resolve(object)

    let checkGroupAccess = !model || !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)
    let promises = []

    guardPreCache = guardPreCache || await this.calculateGuardPreCache(req, fieldsInObj, mode)
    for(let field of fieldsInObj) {
      let promise = this.IsFieldDeclined({req, field, mode, checkGroupAccess, guardPreCache})
        .then( declined => {
          if(declined) {
            delete object[field.key]
          }
          else if(field.subfields) {
            let fieldsOrModel = (field.ref && field.ref != 'RoboFile') ? field.ref : field.subfields

            if(Array.isArray(object[field.key])) {
              let subPromises = object[field.key].map(obj => this.RemoveDeclinedFieldsFromObject({fields: fieldsOrModel, object: obj, mode, req, guardPreCache, DBString: field.DBString}))
              return Promise.all(subPromises)
            }
            else {
              return this.RemoveDeclinedFieldsFromObject({fields: fieldsOrModel, object: object[field.key], mode, req, guardPreCache, DBString: field.DBString})
            }
          }
        })

      promises.push(promise)
    }

    return Promise.all(promises)
  }

  async calculateGuardPreCache(req, fields, mode) {
    let guardType = this.GuardTypes[mode]

    let guards = new Set()
    for(let field of fields) {
      for(let guard of field[guardType]) {
        guards.add(guard)
      }
    }

    let promises = [...guards].map(g => Promisify(g.call(this, req)))
    let res = await Promise.allSettled(promises)

    let preCache = new Map()
    for(let guard of guards) {
      let {status, value} = res.shift()
      let guardValue = status == 'fulfilled' && value

      preCache.set(guard, guardValue)
    }

    return preCache
  }

  /**
   * Checks if a field is declined based on specified parameters.
   * @param {Object} params
   * @param {Object} params.req
   * @param {Object} params.field
   * @param {String} params.mode
   * @param {Boolean} [params.checkGroupAccess=true]
   * @param {Map?} [params.guardPreCache=null]
   * @returns {Promise<Boolean>}
   */
  IsFieldDeclined({req, field, mode, checkGroupAccess = true, guardPreCache = null}) {
    let shouldCheckAccess = mode == 'read' ? req.checkReadAccess : req.checkWriteAccess
    if(!shouldCheckAccess) return Promise.resolve(false)

    if(checkGroupAccess) {
      let groupType = this.GroupTypes[mode]
      if(!this.HasGroupAccess(field[groupType], req.accessGroups)) {
        return Promise.resolve(true)
      }
    }

    return this.IsFieldDecliendByGuards(req, field, this.GuardTypes[mode], guardPreCache)
  }

  /**
 * Checks if a field is declined by guards.
 * @param {Object} req 
 * @param {Object} field
 * @param {String} guardType
 * @param {Map?} [guardPreCache=null]
 * @returns {Promise<boolean>}
 */
  IsFieldDecliendByGuards(req, field, guardType, guardPreCache = null) {
    if(!field[guardType].length) return Promise.resolve(false)

    let promises = field[guardType].map(guard => {
      if(guardPreCache && guardPreCache.has(guard))
        return Promise.resolve(guardPreCache.get(guard))

      return Promisify(guard.call(this, req))
    })

    return Promise.all(promises)
      .then( res => res.some(r => !r) )
      .catch( () => true )
  }

  async RemoveDeclinedFieldsFromSchema(fields, req, mode) {
    let model = null
    if(typeof fields == 'string') { // if model name was given, then we get the models fields
      model = fields
      fields = this.DecycledSchemas[model]
    }

    if(!fields.length) return Promise.resolve(fields)

    let checkGroupAccess = !model || !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)
    let fieldPromises = []

    let guardPreCache = await this.calculateGuardPreCache(req, fields, mode)
    for(let field of fields) {
      let promise = this.IsFieldDeclined({req, field, mode, checkGroupAccess, guardPreCache})
        .then( declined => {
          if(declined) return Promise.reject()

          let promises = [{...field}]

          if(field.subfields) {
            let promise = this.RemoveDeclinedFieldsFromSchema(field.subfields, req, mode) // IMPROVEMENT: we should pass the field.ref to the recursion, so it can optimize more, but it should be passed alongside the fields so we don't get into a infinite loop.
            promises.push(promise)
          }

          return Promise.all(promises)
        })
        .then( ([newField, subfields]) => {
          if(subfields) newField.subfields = subfields
          return newField
        })

      fieldPromises.push(promise)
    }

    return Promise.allSettled(fieldPromises)
      .then( res => res.filter(r => r.status == 'fulfilled').map(r => r.value) )
  }

  getAccesses(model, req) {
    let accesses = {}
    let schema = this.Schemas[this.BaseDBString][model]

    // first we check for read and write accesses on the model itself
    return Promise.all([
      this.HasModelAccess(model, 'read', req),
      this.HasModelAccess(model, 'write', req),
    ])
      .then(([canReadModel, canWriteModel]) => {
        accesses.model = {
          read: canReadModel,
          write: canWriteModel
        }

        // then we go and check each field
        let fieldPromises = []
        for(let mode of ['read', 'write']) {
          let promise = Promise.resolve([])

          if(accesses.model[mode]) {
            let checkGroupAccess = !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)
            promise = this.getFieldAccesses({fields: schema, mode, req, checkGroupAccess})
          }

          fieldPromises.push(promise)
        }

        return Promise.all(fieldPromises)
      })
      .then( ([[canReadAllRequired, read], [canWriteAllRequired, write]]) => {
        accesses.fields = {}

        // we merge the read and write accesses into one object
        let fieldAccesses = {read, write}
        for(let mode of ['read', 'write']) {
          for(let field in fieldAccesses[mode]) {
            if(!accesses.fields[field])
              accesses.fields[field] = {}

            accesses.fields[field][mode] = fieldAccesses[mode][field]
          }
        }

        // once field access are collected, we remove those entries where there is neither read nor write access
        for(let path in accesses.fields) {
          let field = accesses.fields[path]
          if(!field.write && !field.read)
          delete accesses.fields[path]
        }

        accesses.model.writeAllRequired = accesses.model.write && canWriteAllRequired

        return accesses
      })
  }

  /**
   * Retrieves field accesses based on specified parameters.
   * @async
   * @param {Object} params - The parameters for retrieving field accesses.
   * @param {Array} params.fields - The array of fields to retrieve accesses for.
   * @param {String} params.mode - The mode specifying the retrieval behavior.
   * @param {Object} params.req - The request object associated with the operation.
   * @param {Boolean} [params.checkGroupAccess] - Flag indicating whether to check group access.
   * @param {Object} [params.accesses={}] - The object to store the retrieved accesses.
   * @param {String} [params.prefix=''] - The prefix for field names.
   * @param {Map?} [params.guardPreCache=null] - The pre-cache guard object.
   * @returns {Promise} A Promise that resolves with the retrieved field accesses.
   */
  async getFieldAccesses({fields, mode, req, checkGroupAccess, accesses = {}, prefix = '', guardPreCache = null}) {
    guardPreCache = guardPreCache || await this.calculateGuardPreCache(req, fields, mode)
    
    let promises = fields.map(field => this.IsFieldDeclined({req, field, mode, checkGroupAccess, guardPreCache}))
    let results = await Promise.all(promises)

    let subPromises = []
    let trueForAllRequired = true
    for(let field of fields) {
      let absolutePath = prefix + field.key
      accesses[absolutePath] = !results.shift()

      if(field.required && !accesses[absolutePath])
        trueForAllRequired = false

      if(field.subfields && !field.ref && accesses[absolutePath]) {
        let promise = this.getFieldAccesses({fields: field.subfields, mode, req, checkGroupAccess, accesses, prefix: `${absolutePath}.`, guardPreCache})
        subPromises.push(promise)
      }
    }

    let res = await Promise.all(subPromises)
    let trueForAllSubRequired = !res.some(([forAll]) => !forAll)

    return [trueForAllRequired && trueForAllSubRequired, accesses]
  }

  /**
   * A helper function, that is a template for Service routes.
   * @param {Object} req
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
   * Checks if models highest accesses contains an access group whose all elements are in the users accesses
   * @param {String} modelName
   * @param {String} key
   * @param {Array} accessGroups
   */
  hasEveryNeededAccessGroup(modelName, key, accessGroups) {
    return this.Models[modelName].highestAccesses[key].some(ag => ag.every(a => accessGroups.includes(a)))
  }

  async visitFilter({filter, groupVisitor = () => {}, conditionVisitor = (_path, value) => value}) {
    const result = {}
    const promises = []

    for(const outerKey in filter) {
      if(outerKey == '$and' || outerKey == '$or') {
        const conditionPromises = filter[outerKey].map(condition => this.visitFilter({filter: condition, groupVisitor, conditionVisitor}))
        const conditions = await Promise.all(conditionPromises)

        const promise = Promisify(groupVisitor(conditions) )
          .then(value => result[outerKey] = value)

        promises.push(promise)
      }
      else {
        const promise = Promisify(conditionVisitor(outerKey, filter[outerKey]))
          .then(value => result[outerKey] = value)

        promises.push(promise)
      }
    }

    await Promise.allSettled(promises)
    return result
  }

  async extendFilterWithDefaults(modelName, filter) {
    const defaultFilter = this.Models[modelName].defaultFilter

    if(!Object.keys(defaultFilter).length)
      return {...filter}

    const defaultFilterCopy = JSON.parse(JSON.stringify(defaultFilter)) 
    await this.visitFilter({
      filter,
      conditionVisitor: path => delete defaultFilterCopy[path]
    })

    return {...defaultFilterCopy, ...filter}
  }

  async removeDeclinedFieldsFromFilter(req, filter) {
    return await this.visitFilter({
      filter,
      groupVisitor: results => {
        const conditions = results.filter(result => Object.keys(result).length)
        if(!conditions.length)
          return Promise.reject()

        return conditions
      },
      conditionVisitor: async (path, value) => {
        let isDeclined = await this.IsFieldDeclined({req, field: this.PathSchemas[req.params.model][path], mode: 'read'})
        if(isDeclined)
          return Promise.reject()
        
        return value
      }
    })
  }

  async processFilter(req) {
    const originalFilter = JSON.parse(req.query.filter || '{}')
    const extendedFilter = await this.extendFilterWithDefaults(req.params.model, originalFilter)
    const checkedFilter = await this.removeDeclinedFieldsFromFilter(req, extendedFilter)

    return checkedFilter
  }

  async processSort(req) {
    const sortValue = JSON.parse(req.query.sort || '{}')
    const sortObject = this.ObjectifySortValue(sortValue)

    const sort = {...this.Models[req.params.model].defaultSort, ...sortObject}

    const promises = []
    for(let path in sort) {
      const promise = this.IsFieldDeclined({req, field: this.PathSchemas[req.params.model][path], mode: 'read'})
        .then(isDeclined => {
          if(isDeclined)
            delete sort[path]
        })

      promises.push(promise)
    }
    await Promise.all(promises)

    return sort
  }

  /**
   * Generates all the routes of robogo and returns the express router.
   */
  GenerateRoutes() {
    Router.use((req, res, next) => {
      if(req.accessGroups === undefined)
        req.accessGroups = []

      if(req.checkReadAccess === undefined)
        req.checkReadAccess = this.CheckAccess

      if(req.checkWriteAccess === undefined)
        req.checkWriteAccess = this.CheckAccess

      next()
    })

    // CREATE routes
    Router.post( '/create/:model', (req, res) => {
      async function mainPart(req, res) {
        if(req.checkWriteAccess)
          await this.RemoveDeclinedFieldsFromObject({fields: req.params.model, object: req.body, mode: 'write', req})

        const Model = this.MongooseConnection.model(req.params.model)
        const ModelInstance = new Model(req.body)
        return ModelInstance.save()
      }

      async function responsePart(req, res, result) {
        result = result.toObject() // this is needed, because mongoose returns an immutable object by default

        if(req.checkReadAccess)
          await this.RemoveDeclinedFieldsFromObject({fields: req.params.model, object: result, mode: 'read', req})

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'C')
    })
    // ----------------

    // READ routes
    // these routes will use "lean" so that results are not immutable
    Router.get( '/read/:model', (req, res) => {
      async function mainPart(req, res) {
        const filter = await this.processFilter(req)
        const sort = await this.processSort(req)
        console.log(sort)

        return this.MongooseConnection.model(req.params.model)
          .find( filter, req.query.projection )
          .sort( sort )
          .skip( Number(req.query.skip) || 0 )
          .limit( Number(req.query.limit) || null )
          .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, results) {
        if(req.checkReadAccess) await this.RemoveDeclinedFields(req.params.model, results, 'read', req)

        res.send(results)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })

    Router.get( '/get/:model/:id', (req, res) => {
      async function mainPart(req, res) {
        const filter = await this.processFilter(req)

        return this.MongooseConnection.model(req.params.model)
          .findOne({_id: req.params.id, ...filter}, req.query.projection)
          .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, result) {
        if(req.checkReadAccess)
          await this.RemoveDeclinedFieldsFromObject({fields: req.params.model, object: result, mode: 'read', req})

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })

    Router.get( '/search/:model', (req, res) => {
      async function mainPart(req, res) {
        const filter = await this.processFilter(req)

        return this.MongooseConnection.model(req.params.model)
          .find( filter, req.query.projection )
          .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, results) {
        if(req.checkReadAccess)
          await this.RemoveDeclinedFields(req.params.model, results, 'read', req)

        if(!req.query.term)
          return res.send(results)

        if(!req.query.threshold)
          req.query.threshold = 0.4

        if(!req.query.keys || req.query.keys.length == 0) { // if keys were not given, we search in all keys
          let schema = this.DecycledSchemas[req.params.model]

          if(req.checkReadAccess)
            schema = await this.RemoveDeclinedFieldsFromSchema(schema, req, 'read')

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
      async function mainPart(req, res) {
        if(req.checkWriteAccess)
          await this.RemoveDeclinedFieldsFromObject({fields: req.params.model, object: req.body, mode: 'write', req})

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
      async function mainPart() {
        const accesses = await this.getAccesses(req.params.model, req)

        if(!accesses.model.write || Object.values(accesses.fields).some(({write}) => !write))
          return Promise.reject("FORBIDDEN")

        return this.MongooseConnection.model(req.params.model)
          .deleteOne({_id: req.params.id})
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
        let type          = req.file.mimetype
        let extension     = req.file.originalname.split('.').pop()
        let filePath      = `${req.file.filename}.${extension}` // the file will be saved with the extension attached

        fs.renameSync(multerPath, `${multerPath}.${extension}`)

        let fileData = {
          name: req.file.originalname,
          path: filePath,
          size: req.file.size,
          extension: extension,
          type
        }

        // we create the RoboFile document with the properties of the file
        RoboFileModel.create(fileData, (err, file) => {
          if(err) res.status(500).send(err)
          else res.send(file)
        })
      })

      Router.post( '/fileclone/:id', (req, res) => {
        RoboFileModel.findOne({_id: req.params.id}).lean()
          .then( roboFile => {
            let realPath = path.resolve(this.FileDir, roboFile.path)
            if(!realPath.startsWith(this.FileDir)) return Promise.reject('INVALID PATH')

            let copyRealPath = realPath.replace('.', '_copy.')
            if(fs.existsSync(realPath)) fs.copyFileSync(realPath, copyRealPath)
            
            if(roboFile.thumbnailPath) {
              let thumbnailPath = path.resolve(this.FileDir, roboFile.thumbnailPath)
              if(!thumbnailPath.startsWith(this.FileDir)) return Promise.reject('INVALID PATH')

              let copyThumbnailPath = thumbnailPath.replace('.', '_copy.')
              if(fs.existsSync(thumbnailPath)) fs.copyFileSync(thumbnailPath, copyThumbnailPath)
            }
 
            delete roboFile._id
            roboFile.path = roboFile.path.replace('.', '_copy.')
            roboFile.thumbnailPath = roboFile.thumbnailPath.replace('.', '_copy.')
 
            return RoboFileModel.create(roboFile)
          })
          .then( file => res.send(file) )
          .catch( err => res.status(500).send(err) )
      })

      Router.delete( '/filedelete/:id', (req, res) => {
        RoboFileModel.findOne({_id: req.params.id})
          .then( file => {
            if(!file) return Promise.reject('Unkown file')

            // we remove both the file and thumbnail if they exists
            let realPath = path.resolve(this.FileDir, file.path)
            if(!realPath.startsWith(this.FileDir)) return Promise.reject('INVALID PATH') // for safety, if the resolved path is outside of FileDir we return 500 INVALID PATH
            if(fs.existsSync(realPath)) fs.unlinkSync(realPath)

            if(file.thumbnailPath) {
              let thumbnailPath = path.resolve(this.FileDir, file.thumbnailPath)
              if(!thumbnailPath.startsWith(this.FileDir)) return Promise.reject('INVALID PATH') // for safety, if the resolved path is outside of FileDir we return 500 INVALID PATH
              if(fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath)
            }

            // we delete the RoboFile document
            return RoboFileModel.deleteOne({_id: file._id})
          })
          .then( () => res.send() )
          .catch( err => res.status(400).send(err) )
      })
    }
    // --------------

    // SPECIAL routes
    Router.get( '/model/:model', (req, res) => {
      async function mainPart(req, res) {
        return await this.HasModelAccess(req.params.model, 'read', req)
      }

      async function responsePart(req, res, hasAccess) {
        if(!req.checkReadAccess || hasAccess)
          res.send({...this.Models[req.params.model], model: req.params.model})
        else
          res.status(403).send()
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/model', (req, res) => {
      let promises = []
      for(let modelName in this.Models) {
        let promise = this.HasModelAccess(modelName, 'read', req)
        promises.push(promise)
      }

      Promise.all(promises)
        .then( results => {
          let models = []

          for(let modelName in this.Models) {
            if(req.checkReadAccess && !results.shift()) continue

            models.push({...this.Models[modelName], model: modelName})
          }

          res.send(models)
        })
    })

    Router.get( '/schema/:model', (req, res) => {
      async function mainPart(req, res) {
        return this.DecycledSchemas[req.params.model]
      }

      async function responsePart(req, res, result) {
        if(req.checkReadAccess)
          result = await this.RemoveDeclinedFieldsFromSchema(result, req, 'read')

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/fields/:model', (req, res) => {
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if(req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req, 'read')

        let fields = this.GetFields(schema, req.query.depth)
        return fields
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/count/:model', (req, res) => {
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

    Router.get( '/searchkeys/:model', (req, res) => {
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if(req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req, 'read')

        return this.GetSearchKeys(schema, req.query.depth)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/accessesGroups', (req, res) => {
      let result = Object.keys(this.AccessGroups)
      res.send(result)
    })

    Router.get( '/accesses/:model', (req, res) => {
      async function mainPart(req, res) {
        return await this.getAccesses(req.params.model, req)
      }

      async function responsePart(req, res, result) {
        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    return Router
  }
}

function Promisify(value) {
  if(value instanceof Promise) return value
  return Promise.resolve(value)
}

module.exports = Robogo
