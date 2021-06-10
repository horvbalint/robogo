
# robogo

Robogo is a backend multitool for projects using [MongoDB](https://www.mongodb.com/), [Mongoose](https://www.npmjs.com/package/mongoose) and [Express](https://www.npmjs.com/package/express). Its aim is to reduce the amount of time needed to start, extend and maintain a project. Robogo started out as a CRUD operation helper, but soon evolved into a much more complex system with a lots of features on top of being a CRUD engine.

It is recommended to use this package's frontend helper [robolt](TODO) to make things simpler on the frontend.


## Table of contents
* [Getting started](#installSection)
* [Schemas](#schemasSection)
* [Field Access](#fieldaccessSection)
* [Working with files](#filesSection)
* [Services](#servicesSection)
* [Routes:](#routesSection)
  * [Create](#createRoutes)
  * [Read](#readRoutes)
  * [Update](#updateRoutes)
  * [Delete](#deleteRoutes)
  * [Service](#serviceRoutes)
  * [File](#fileRoutes)
  * [Special](#specialRoutes)
* [Middlewares](#middlewareSection)



## Disclaimer
We take no responsibility for any demage done by this package.

If you find anything that isn't working or not up to the documentation, please open issue or a pull request over on [github](https://github.com/horvbalint/robogo/issues).

Thank You in advance!



<br></br>
<a name="installSection"></a>
## Getting started
> The documentation will refer back to this section, so don't worry if you don't understand something now.

A very simple example:
```javascript
const Robogo = require('robogo') // import the package

const robogo = new Robogo({
  SchemaDir: path.resolve(__dirname, './schemas')
}) // create the instance

// here should be your auth middleware
// something like: Router.use(someGenericAuthMiddlware) 

Router.use('/api', robogo.GenerateRoutes()) // register as a route
```

The constructor uses the following parameters:
| Parameter | Type | Description | Default |
|:-|:-:|:-:|:-:|
| SchemaDir          | String  | Absolute path to a folder containing files that are exporting the models that should be handled by robogo.                                                                                                                           |                     |
| ServiceDir         | String  | Absolute path to the folder that is containing the service files.                                                                                                                                                                         | null                |
| FileDir            | String  | Absolute path to the folder in which uploaded files should be stored.                                                                                                                                                                     | null                |
| ServeStaticPath    | String  | Relative path through which files in the FileDir will be accessible.                                                                                                                                                                      | '/static'           |
| MaxImageSize       | Number  | Uploaded images higher or wider then this number will be resized to this size.**\*** | 800                 |
| CreateThumbnail    | Boolean | Indicates whether robogo should create a small sized version of the images that are uploaded or not.                                                                                                                                  | false               |
| MaxThumbnailSize   | Number  | If CreateThumbnail is true, it behaves the same way as MaxImageSize but for thumbnail images.                                                                                                                                             | 200                 |
| MongooseConnection | Object  | Only needed if the mongoose connection was created using mongoose.connect().                                                                                                                    | require('mongoose') |
| CheckAccess        | Boolean | Indicates whether robogo should use its access features. Disabling it will speed operations up when handling huge documents.                                                                                                          | true                |
| ShowLogs           | Boolean | Indicates whether robogo should log basic information to the console.                                                                                                                                                                 | true                |
| ShowWarnings       | Boolean | Indicates whether robogo should log warning messages to the console.                                                                                                                                                                  | true                |
| ShowErrors         | Boolean | Indicates whether robogo should log error messages to the console.                                                                                                                                                                    | true                |

**\* Note**: Even if an image is already smaller then the size specified it will be compressed to take up less space. If null is given as value no resizing or compressing will be done.

<a name="schemasSection"></a>
## Schemas
Robogo is a solid base for you to build upon automated processes. For this you can provide some additional information in your schemas, that you can use later. 

> The documentation will refer back to this section, so don't worry if you don't understand something now.

| Field   | Description   | Default |
|:-|:-:|:-:|
| name           | Can be used to display as an input label or table column name. e.g.: {type String, name: “Username”}                     |         |
| description    | Can be used to display as a hover tooltip text. e.g.: {type String, description: “Unique identifier of the user”}        |         |
| minWriteAccess | A positive number. If given, one needs an accesslevel higher or equal to create, update or delete this field             | 0       |
| minReadAccess  | A positive number. If given, one needs an accesslevel higher or equal to read this field                                 | 0       |
| marked         | Simply marks this field, that you can interpret later like however you want it                                                 | false   |
| hidden         | Fields marked as hidden will not be included in the result of the '/fields/:model' route                                 | false   |

An example schema can look like this:

```javascript
// This is the schemas/user.js file
const mongoose = require("mongoose")
const autopopulate = require("mongoose-autopopulate") // Not required, but suggested to be used with file handling (https://www.npmjs.com/package/mongoose-autopopulate)

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    name: 'Username',
    description: "Unique identifier of the user",
    minWriteAccess: 100, // One has to have an accesslevel of 100 or higher to create this field
    minReadAccess: 0, // But don't need it to read it
    marked: true
  },
  avatar: {
    type: ObjectId,
    ref: "RoboFile", // File refrences will be stored in this special schema
    autopopulate: true, // Not required, but suggested to be used for file fields
    name: "Avatar"
  },
  friends: {
    type: [new mongoose.Schema({
      name: {type: String, name: "A friends name"}
    })],
    name: "List of the users friends",
    hidden: true
  }
}, { selectPopulatedPaths: false }) // We usually need this if using mongoose-autopopulate otherwise fields will always be present when queried regardless of the projection 

UserSchema.plugin(autopopulate) // Not required, but suggested to be used with file handling
module.exports = mongoose.model('User', UserSchema) // Export the model so that Robogo can import it later
```


<br></br>
<a name="fieldaccessSection"></a>
## Field access
Most of the time we want to make differences between users in the sense of who can see or modify the data in the database. Robogo provides an easy to use system that makes it possible for us to **manage accesses on every field of every document**.

For this to work an express.js middleware has to add an access level number to the req object (as **req.accesslevel**) of every request. If this is not present the accesslevel of the request will be set to 0 by default. We must also include some special attributes for the fields of our schemas, as described in the [Schemas](#schemasSection) chapter. 

[Read routes](#readRoutes) will scan trough the results of the database query and remove every field that has a higher **minReadAccess** then the provided accesslevel in the req object. So if a field requires a minReadAccess of 100 then a user with an accesslevel of 50 will get the field removed from the results. 

In the case of [Create](#createRoutes) and [Update](#updateRoutes) routes the **minWriteAccess** will matter mostly. Fields that have a higher minWriteAccess then the provided accesslevel will be removed before trying to save them in the database. This will cause a mongoose error, when a required field is removed, so only those will be able to create documents who have a high enough accesslevel to modify every required field of a model. [Create routes](#createRoutes) also use minReadAcces as they send back the result of the operation to the client as response.

If someone is trying to delete a document with a field with greater minWriteAccess then the users accesslevel, the request will fail and the 'EPERM' message will be sent back.



<br></br>
<a name="filesSection"></a>
## Working with files
Robogo can help greatly with file handling. Files sent to its '/fileupload' path will be saved automatically into the folder given to the constructor as the 'FileDir' parameter. Images can be compressed and resized with no hassle, it can even create thumbnail images if needed.  These functionalities can be configured in the constructor of robogo. You can get more information on them in the [Getting started](#installSection) chapter. The [Routes - File](#fileRoutes) section describes the routes that can be used to create new or delete and access the uploaded files.

Robogo  creates a special **RoboFile** model to store information about the files it handles.  This special model can not be handled by robogos default routes. Every time a file is uploaded an instance of this model is saved into the database containing the properties of the file. You can reference this document in your documents like in the example of the [Schemas](#schemasSection) chapter.

The RoboFile model has the following schema:
```js
{
  name: { type: String,  name: "File name", description: "Name of the saved file", required: true, marked: true },
  path: { type: String,  name: "File path", description: "Path of the saved file", required: true },
  size: { type: Number,  name: "File size", description: "Size of the saved file", required: true },
  extension: { type: String,  name: "File extension", description: "Extension of the saved file", required: true },
  isImage: { type: Boolean, name: "Is image?", description: "Indicates whether the saved file is an image or not", default: false },
  thumbnailPath: { type: String,  name: "Thumbnail path", description: "Path of the saved thumbnail", default: null },
}
```


<br></br>
<a name="servicesSection"></a>
## Services
Services are just like normal express.js routes that are registered automatically by and can be reached through robogo. Every service's functions can be reached with both GET and POST methods, depending on which robogo route was used when calling it.

Services are created by creating separate .js files that are containing one or more service functions.  These files should export an object containing the service functions of the service. Service files should then be put in a single folder and this folder should be registered in robogo by giving the path of it to the constructor as the 'ServiceDir' parameter.

Service functions are identified and called by providing their service name (name of the .js file they are in) and their function name. All service functions must return a Promise whose resolved value will be sent back as a response to the client. Rejecting the Promise will send the rejected error back to the client, with a status code of 500. Service functions can use three parameters, that are in order:
  * **req**: Request object (from Express.js)
  * **res**: Response object (from Express.js)
  * **data**: req.body or req.query depending on the HTTP method used - for easy access.

Here is an example service file:
```javascript
// services/user.js file

const Services = {
  // service function created using async/await
  clearFriends: async (req, res, data) => {
    let userId = data.id
  
    try {
      deleteFriendsOfUser(userId)
      return 'Success'
    } catch(err) {
	  throw 'Failed'
    }
  },
  
  // service function created using Promise
  removeAvatar: (req, res, data) => {
    return new Promise((resolve, reject) => {
      let userId = data.id
      
      deleteAvatarOfUser(userId)
        .then( () => resolve('Success') )
        .catch( () => reject('Failed')
    })
  },
}

module.exports = Services
```


<br></br>
<a name="routesSection"></a>
## Routes

In this section you can find the description of the endpoints that are created by robogo. All of the routes are prefixed with the path that was used, when [the routes were registered in Express using the GenerateRoutes method](#installSection). So in this example '/api'.

It is recommended to use this package's frontend helper [robolt](TODO), that will hide the complexity of the routes.

<a name="createRoutes"></a>
### Create routes

#### /:model
>Creates a new document.
* Method: POST
* Returns: Object (MongoDB document)
```javascript
// an example using the axios library
axios.post('/api/User', UserData)
```
##### Params:
An object that matches the given models schema. The whole req.body should be the object.


<br></br>
<a name="readRoutes"></a>
### Read routes

#### /:model/find
>Returns documents for the given model.
* Method: GET
* Returns: Array\<Object\>

```javascript
// an example using the axios library
axios.get('/api/User/find', {
  params: {
	  filter: {Chandler: {$in: friends}},
	  projection: ['username', 'friends'],
	  sort: {username: 1},
	  skip: 10,
	  limit: 5
  }
})
```

##### Params:
| key | type | description | example |
|:-|:-:|:-:|:-:|
| filter | Object | [Mongodb query](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.htmls) | {Chandler: {$in: friends}} |
| projection | Array\<String\> | Fields to include in results. Uses MongoDB [projection](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.html). | ['username', 'friends'] |
| sort | Object | [Mongodb sort](https://docs.mongodb.com/manual/reference/method/cursor.sort/index.html) | { age : 1 } |
| skip | Number | The number of documents to skip in the results set. | 10 |
| limit | Number | The number of documents to include in the results set. | 5 |


<br></br>
#### /:model/:id
> Returns one document for the given model that matches the given id.
* Method: GET
* Returns: Object
```javascript
// an example using the axios library
axios.get('/api/User/507f191e810c19729de860ea', {
  params: {
	  projection: ['username', 'friends']
  }
})
```
##### Params:
| key | type | description | example |
|:-|:-:|:-:|:-:|
| projection | Array\<String\> | Fields to include in [projection](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.html). | ['username', 'friends'] |


<br></br>
#### /search/:model
> Returns documents for the given model that are matching the given search term. This route uses the [Fuse.js](https://www.npmjs.com/package/fuse.js) library in the background. Searching in huge amount of keys and data can be slow and searching in date fields is not supported.

* Method: GET
* Returns: Array\<Object\>

```javascript
// an example using the axios library
axios.get('/search/User', {
  params: {
    filter: {Chandler: {$in: friends}},
    projection: ['username', 'friends'],
    threshold: 0.4,
    keys: ['username'],
    term: 'search term',
  }
})
```

##### Params:
| key | type | description | example |
|:-|:-:|:-:|:-:|
| filter | Object | [Mongodb query](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.htmls) | {Chandler: {$in: friends}} |
| projection | Array\<String\> | Fields to include in results. Uses MongoDB [projection](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.html). | ['username', 'friends'] |
| threshold | Number | [Fuse.js](https://www.npmjs.com/package/fuse.js) threshold, defaults to 0.4 | 0.6 |
| keys | Array\<String\> | Keys of the document that are searched in. If no keys are provided all keys of the document will be used. | ['username'] |
| term | String | Search term that is searched for | 'search term' |


<br></br>
<a name="updateRoutes"></a>
### Update routes

#### /:model
>Updates a document matched by its _id field.
* Method: PATCH
* Returns: [WriteResults](https://docs.mongodb.com/manual/reference/method/db.collection.update/#std-label-writeresults-update)

```javascript
// an example using the axios library
axios.patch('/api/User', UpdatedUser)
```
##### Params:
The whole body should be an object with an _id field containing the ObjectId of the document we want to update and the fields we want to change with their new values.


<br></br>
<a name="deleteRoutes"></a>
### Delete routes

#### /:model/:id
>Deletes the document of the given model matched by the given id.
* Method: DELETE
* Returns: [WriteResults](https://docs.mongodb.com/manual/reference/method/db.collection.update/#std-label-writeresults-update)

```javascript
// an example using the axios library
axios.delete('/api/User/507f191e810c19729de860ea')
```


<br></br>
<a name="serviceRoutes"></a>
### Service routes

There are two types of services: getters and runners. The difference between the two is just the HTTP-method they are using. Runners use POST so you can send data more easily and not get the results cached. Getters use GET so you can get the results cached if needed.

#### /getter/:service/:function
>Runs a function in services.
* Method: GET
* Returns: Any

```javascript
// an example using the axios library
axios.get('/api/getter/user/clearFriends')
```

<br></br>
#### /runner/:service/:function
>Runs a function in services.
* Method: POST
* Returns: Any

```javascript
// an example using the axios library
axios.post('/api/runner/user/clearFriends')
```


<br></br>
<a name="fileRoutes"></a>
### File routes
The following routes are only available, if the FileDir parameter was provided in the constructor.

#### /fileupload
>Uploads a given file, and generates a unique name for it. We must send the file as multipart/form-data.
If the file is an image and the CreateThumbnail option was set to true in the constructor it will generate a thumbnail for it. Thumbnail images will have names like 'fileUniqueName_thumbnail.jpg'.
* Method: POST
* Returns: Object (RoboFile document)

```js
// an example using the axios library
let formData = new FormData()
formData.append('file', UserAvatar) // the field name must be 'file'

axios.post(`/api/fileupload`, formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
})
```


<br></br>
#### /filedelete/:id
>Deletes the RoboFile document with the given id and the corresponding file from the FileDir.
* Method: DELETE
* Returns: empty response

```js
axios.delete(`/api/filedelete/:id`)
```

<br></br>
<a name="specialRoutes"></a>
### Special routes

####  /schema/:model
>Special route that returns everything there is to know about the given model's schema  (its fields and their properties).
* Method: GET
* Returns: Object

```javascript
// an example using the axios library
axios.get('/api/schema/User')
```


<br></br>
#### /fields/:model
>  Returns a tree-like structure of the fields and their properties for the given model. Similar to the '/schema/:model' route, but only returns a reduced set of properties and leaves out fields that were marked as "hidden" in the schema. The returned properties are: name, key, description, type, isArray, marked.
* Methods: GET
* Returns: Array<Object\>

```javascript
// an example using the axios library
axios.get('/api/fields/User')
```


<br></br>
#### /count/:model
>Returns the count of documents for the given model that are matched by the given filter.
* Method: GET
* Returns: Array\<Object\>

```javascript
// an example using the axios library
axios.get('/api/count/User', {
  params: {
	filter: {Chandler: {$in: friends}},
  }
})
```
Params:

| key | type | description | example |
|:-|:-:|:-:|:-:|
| filter | Object | [Mongodb query](https://docs.mongodb.com/manual/reference/method/db.collection.find/index.htmls) | {Chandler: {$in: friends}} |



<br></br>
<a name="middlewareSection"></a>
## Adding custom middlewares

If needed, we can extend the functionalities of the default routes of robogo with middlewares. Middleware functions **have to return a Promise**. This Promise should be resolved when the middleware is done with its work and the route should continue running. Rejecting the Promise will stop the route from continuing and (if the 'ShowLogs' parameter of the constructor was set to true) the value given to the reject function will be written to the console. In this case **do not forget** to send a response from inside the middleware. Every middleware's 'this' context is the robogo instance it was registered in.

There are four categories of routes that can have middlewares:
  * **C**(reat)
  * **R**(ead)
  * **U**(pdate)
  * **D**(elete)

Each route-category can have a 'before' and an 'after' middleware.

<br></br>
### 'before' middlewares

'before' middlewares will run before the database operation, so they can be used for example to deny permission to a route based on some logic using the Request object, or they can modify the payload of the request, before it reaches the database part of the route.

**Parameters**:
'before' middlewares receive two parameters. These are in order:
  *   **req**: Request object (from Express.js)
  *   **res**: Response object (from Express.js)


<br></br>
### 'after' middlewares

'after' middlewares will run after the database operation, so they can be used for example to modify the result of the database operation before sending back a response.

**Parameters**:
'after' middlewares receive three parameters. These are in order:
  *   **req**: Request object (from Express.js)
  *   **res**: Response object (from Express.js)
  *  **result**: Any (the result of the database operation)


<br></br>
### Registering middlewares

Middlewares can be registered by calling the **'addMiddleware'** method of the robogo instance. The method has four parameters, these are in order:
  * **modelname**: String, the name of the model that the middleware should be bound to.
  * **operation**: String, the initial of one of the four route-categories ('C', 'R', 'U', 'D').
  * **timing**: String, one of the timing options ('before', 'after').
  * **function**: Function, the middleware function returning a Promise.

The 'addMiddleware' method can throw the following exceptions:
  * 'Middleware: No model found with name: ${modelname}'
  * 'Middleware: Operation should be one of: [ 'C', 'R', 'U', 'D' ]'
  * 'Middleware: Timing should be one of: [ 'after', 'before' ]'


<br></br>
Here are some example middlewares:
```javascript
const robogo = new Robogo({
  SchemaDir: path.resolve(__dirname,  './schemas')
}) // create the robogo instance

try {
  // middleware created using async/await
  robogo.addMiddleware('User', 'C', 'before', async (req, res) => {
    if(await isNotAdmin(req.query.uId)) {
      res.status(401).send('YOU SHALL NOT PASS!') // we have to send a response
      throw `${req.query.uId} tried to access restricted information!` // this message will be logged to the console
    }
  })

  // middleware created using Promise
  robogo.addMiddleware('User', 'C', 'before', (req, res) => {
    return new Promise((resolve, reject) => {
      isNotAdmin(req.query.uId).then(isNotAdmin => {
        if(!isNotAdmin) resolve()
        else {
          res.status(401).send('YOU SHALL NOT PASS!') // we have to send a response
	      reject(`${req.query.uId} tried to access restricted information!`) // this message will be logged to      
        }
      })
    })
  })
} catch(e) {
  console.warn("Setting up middlewares not succeeded. Error was: ", e);
}
```


## Contributing
Every contribution is more then welcomed. If you have an idea or made some changes to the code, please open an issue or pull request at the package's [github page](https://github.com/horvbalint/robogo/issues).  

## Authors
* Horváth Bálint
* Zákány Balázs