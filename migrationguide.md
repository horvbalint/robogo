* Search route: POST -> GET
* Search route: pattern -> term
* Schema: primary -> marked
* Schema: CRUDFile -> RoboFile
* RoboSchema: subheaders -> subfields
* Route: tableheaders -> fields
* Route: /schemakeys/:model -> /searchkeys/:model
* Method: GetSchemaKeys maxDepth defaults to Infinity not 2
* Method: RemoveDeclinedFields*: acclevel, model, data -> model, data, acclevel
* Method: GetHeaders -> GetFields
* Constructor: MaxHeaderDepth removed
* Constructor: SchemaDIR -> SchemaDir
* Constructor: FileDIR -> FileDir
* Constructor: ServiceDIR -> ServiceDir