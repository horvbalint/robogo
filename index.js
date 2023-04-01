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
    Softwares = [],
    AccessGroups = {},
    AdminGroups = null,
    ShowErrors = true,
    ShowWarnings = true,
    ShowLogs = true,
  }) {
    this.MongooseConnection     = MongooseConnection
    this.BaseDBString        = String(MongooseConnection.connections[0]._connectionString)
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
    this.AdminGroups             = AdminGroups

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
   * Recursively collects access groups from tree to array without duplications
   * @param {Object} accesTree
   * @returns {{read: Array, write: Array}}
   */
  createAccessGroupFromTree(accessTree, accessArray = new Set()) {
    if(!Object.keys(accessTree).length) return [...accessArray]

    for(let [node, subTree] of Object.entries(accessTree)) {
      accessArray.add(node)
      this.createAccessGroupFromTree(subTree, accessArray)
    }

    return [...accessArray]
  }

  /**
   * Recursively collects access groups from tree to array without duplications
   * @param {Object} accesTree
   * @returns {{read: Array, write: Array}}
   */
  createAccessGroupFromTree(accessTree, accessArray = new Set()) {
    if(!Object.keys(accessTree).length) return [...accessArray]

    for(let [node, subTree] of Object.entries(accessTree)) {
      accessArray.add(node)
      this.createAccessGroupFromTree(subTree, accessArray)
    }

    return [...accessArray]
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
      this.plugInFieldRef(fObj)
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
      return res.status(500).send('MISSING MODEL')
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

    if(!this.HasGroupAccess(this.Models[model][groupType], req.accessGroups)) {
      return Promise.resolve(false)
    }

    if(this.Models[model].accessGuards) {
      let promises = this.Models[model].accessGuards.map(guard => Promisify(guard(req)))
      return Promise.all(promises)
        .then( res => {
          if(res.some(r => !r)) return Promise.resolve(false)
        })
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
    return !goodGroups || goodGroups.some(fa => accessGroups.includes(fa))
  }

  /**
   * Removes every field from an array of documents, which need an access group not included in then given parameter.
   * @param {String} modelName
   * @param {Array} documents
   * @param {Number} [accessGroups]
   * @param {String} [authField='readGroups']
   */
  RemoveDeclinedFields(modelName, documents, mode, req) {
    let promises = documents.map(doc => this.RemoveDeclinedFieldsFromObject(modelName, doc, mode , req))

    return Promise.all(promises)
  }

  RemoveDeclinedFieldsFromObject(fields, object, mode, req, DBString = this.BaseDBString) {
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

    for(let field of fieldsInObj) {
      let promise = this.IsFieldDeclined(field, mode, req.accessGroups, req, checkGroupAccess)
        .then( declined => {
          if(declined) {
            delete object[field.key]
          }
          else if(field.subfields) {
            let fieldsOrModel = fields.ref || field.subfields

            if(Array.isArray(object[field.key])) {
              let subPromises = object[field.key].map(obj => this.RemoveDeclinedFieldsFromObject(fieldsOrModel, obj, mode, req, field.DBString))
              return Promise.all(subPromises)
            }
            else {
              return this.RemoveDeclinedFieldsFromObject(fieldsOrModel, object[field.key], mode, req, field.DBString)
            }
          }
        })

      promises.push(promise)
    }

    return Promise.all(promises)
  }

  IsFieldDeclined(field, mode, accessGroups, req, checkGroupAccess = true) {
    let groupType = this.GroupTypes[mode]
    if(checkGroupAccess) {
      if(!this.HasGroupAccess(field[groupType], accessGroups)) {
        return Promise.resolve(true)
      }
    }

    let guardType = this.GuardTypes[mode]
    if(field[guardType].length) {
      let promises = field[guardType].map(guard => Promisify(guard(req)))

      return Promise.all(promises)
        .then( res => {
          if(res.some(r => !r)) return true
          else return false
        })
        .catch(() => true)
    }

    return Promise.resolve(false)
  }

  RemoveDeclinedFieldsFromSchema(fields, req) {
    let model = null
    if(typeof fields == 'string') { // if model name was given, then we get the models fields
      model = fields
      fields = this.DecycledSchemas[model]
    }

    if(!fields.length) return Promise.resolve(fields)

    let checkGroupAccess = !model || !this.hasEveryNeededAccessGroup(model, 'read', req.accessGroups)
    let fieldPromises = []

    for(let field of fields) {
      let promise = this.IsFieldDeclined(field, 'read', req.accessGroups, req, checkGroupAccess)
        .then( declined => {
          if(declined) return Promise.reject()

          let promises = [{...field}]

          if(field.subfields) {
            let fieldsOrModel = fields.ref || field.subfields

            let promise = this.RemoveDeclinedFieldsFromSchema(fieldsOrModel, 'read', req)
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

          let checkGroupAccess = !this.hasEveryNeededAccessGroup(model, mode, req.accessGroups)

          if(accesses.model[mode])
            promise = this.getFieldAccesses(schema, mode, req, checkGroupAccess)

          fieldPromises.push(promise)
        }

        return Promise.all(fieldPromises)
      })
      .then( ([[canReadAllRequired, read], [canWritAllRequired, write]]) => {
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

        accesses.model.writeAllRequired = accesses.model.write && canWritAllRequired

        return accesses
      })
  }

  async getFieldAccesses(schema, mode, req, checkGroupAccess, accesses = {}, prefix = '') {
    let promises = schema.map(field => this.IsFieldDeclined(field, mode, req.accessGroups, req, checkGroupAccess))
    let results = await Promise.all(promises)

    let subPromises = []
    let trueForAllRequired = true
    for(let field of schema) {
      let absolutePath = prefix + field.key
      accesses[absolutePath] = !results.shift()

      if(field.required && !accesses[absolutePath])
        trueForAllRequired = false

      if(field.subfields && !field.ref && accesses[absolutePath]) {
        let promise = this.getFieldAccesses(field.subfields, mode, req, checkGroupAccess, accesses, `${absolutePath}.`)
        subPromises.push(promise)
      }
    }

    let res = await Promise.all(subPromises)
    let trueForAllSubRequired = !res.some(([forAll]) => !forAll)

    return [trueForAllRequired && trueForAllSubRequired, accesses]
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
   * Checks if models highest accesses contains an access group whose all elements are in the users accesses
   * @param {String} model
   * @param {String} key
   * @param {Array} accessGroups
   */
  hasEveryNeededAccessGroup(modelName, key, accessGroups) {
    return this.Models[modelName].highestAccesses[key].some(ag => ag.every(a => accessGroups.includes(a)))
  }

  /**
   * Generates all the routes of robogo and returns the express router.
   */
  GenerateRoutes() {
    // Middleware that adds default values to robogo properties if they were not specified
    Router.use( (req, _, next) => {
      if(req.accessGroups === undefined)
        req.accessGroups = []

      if(req.checkAccess === undefined)
        req.checkAccess = this.CheckAccess

      next()
    })
    // CREATE routes
    Router.post( '/create/:model', (req, res) => {
      async function mainPart(req, res) {
        if(req.checkAccess)
          await this.RemoveDeclinedFieldsFromObject(req.params.model, req.body, 'write', req)

        const Model = this.MongooseConnection.model(req.params.model)
        const ModelInstance = new Model(req.body)
        return ModelInstance.save()
      }

      async function responsePart(req, res, result) {
        result = result.toObject() // this is needed, because mongoose returns an immutable object by default

        if(req.checkAccess)
          await this.RemoveDeclinedFieldsFromObject(req.params.model, result, 'read', req)

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
          .sort( JSON.parse(req.query.sort || '{}') )
          .skip( Number(req.query.skip) || 0 )
          .limit( Number(req.query.limit) || null )
          .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, results) {
        if(req.checkAccess) await this.RemoveDeclinedFields(req.params.model, results, 'read', req)

        res.send(results)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'R')
    })

    Router.get( '/get/:model/:id', (req, res) => {
      function mainPart(req, res) {
        return this.MongooseConnection.model(req.params.model)
          .findOne({_id: req.params.id, ...JSON.parse(req.query.filter || '{}')}, req.query.projection)
          .lean({ autopopulate: true, virtuals: true, getters: true })
      }

      async function responsePart(req, res, result) {
        if(req.checkAccess)
          await this.RemoveDeclinedFieldsFromObject(req.params.model, result, 'read', req)

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
        if(req.checkReadAccess)
          await this.RemoveDeclinedFields(req.params.model, results, 'read', req)

        if(!req.query.term)
          return res.send(results)

        if(!req.query.threshold)
          req.query.threshold = 0.4

        if(!req.query.keys || req.query.keys.length == 0) { // if keys were not given, we search in all keys
          let schema = this.DecycledSchemas[req.params.model]

          if(req.checkReadAccess)
            schema = await this.RemoveDeclinedFieldsFromSchema(schema, req)

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
        if(req.checkAccess)
          await this.RemoveDeclinedFieldsFromObject(req.params.model, req.body, 'write', req)

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
        let fields = this.DecycledSchemas[req.params.model]
        let remainingFields = await this.RemoveDeclinedFieldsFromSchema(req.params.model, req)

        if(JSON.stringify(fields) !== JSON.stringify(remainingFields))
          return res.status(403).send()

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
    Router.get( '/model/:model', (req, res) => {
      this.HasModelAccess(req.params.model, 'read', req)
        .then( hasAccess => {
          if(hasAccess)
            res.send({...this.Models[req.params.model], model: req.params.model})
          else
            res.status(403).send()
        })
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
            if(!results.shift()) continue

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
        if(req.checkAccess)
          result = await this.RemoveDeclinedFieldsFromSchema(result, req)

        res.send(result)
      }

      this.CRUDSRoute(req, res, mainPart, responsePart, 'S')
    })

    Router.get( '/fields/:model', (req, res) => {
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if(req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req)

        let fields = this.GetFields(schema, req.query.depth)
        return fields
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
      async function mainPart(req, res) {
        let schema = this.DecycledSchemas[req.params.model]

        if(req.checkReadAccess)
          schema = await this.RemoveDeclinedFieldsFromSchema(schema, req)

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
