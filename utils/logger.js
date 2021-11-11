class Logger {
  constructor({ShowErrors, ShowWarnings, ShowLogs}) {
    this.ShowErrors = ShowErrors
    this.ShowWarnings = ShowWarnings
    this.ShowLogs = ShowLogs
  }

  // The functions below are the logs of robogo, they are formatted using bash sequences.
  // Colors and formattings can be found at: https://misc.flogisoft.com/bash/tip_colors_and_formatting
  // \e[ should be changed to \x1b[ to work with Node.js
  LogMessage(type, occurrence, title, description) {
    let mainTitle, color

    if(type == 'error') {
      if(!this.ShowErrors) return
      mainTitle = 'ROBOGO ERROR'
      color = 91
    }
    else if(type == 'warning') {
      if(!this.ShowWarnings) return
      mainTitle = 'ROBOGO WARNING'
      color = 93
    }
    else if(type == 'log') {
      if(!this.ShowLogs) return
      mainTitle = 'ROBOGO LOG'
      color = 34
    }

    console.log(`\x1b[${color}m\x1b[7m\x1b[1m%s\x1b[0m`, `\n ${mainTitle} `)
    console.log(`\x1b[${color}m%s\x1b[0m`, `occurred while ${occurrence}.\n`)
    console.log(`\x1b[${color}m\x1b[1m%s\x1b[0m`, title)
    console.log(`\x1b[${color}m%s\x1b[0m`, description, '\n')
  }

  LogMissingModel(modelName, occurrence) {
    let title = `MISSING MODEL: '${modelName}'`
    let description = `
There is no model registered with the name '${modelName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the model is in the folder which was given to robogo
  • the file is exporting the model, so robogo can import it`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMissingService(serviceName, occurrence) {
    let title = `MISSING SERVICE: '${serviceName}'`
    let description = `
There is no service registered with the name '${serviceName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the service is in the folder which was given to robogo
  • the file is exporting the service, so robogo can import it`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMissingServiceFunction(serviceName, functionName, occurrence) {
    let title = `MISSING SERVICE FUNCTION: '${functionName}'`
    let description = `
There is no function in the service '${serviceName}' with the name '${functionName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the '${serviceName}' service is the one containing the function`

    this.LogMessage('error', occurrence, title, description)
  }

  LogUnknownOperation(operation, occurrence) {
    let title = `UNKNOWN OPERATION: '${operation}'`
    let description = `
No operation exists with the name '${operation}'.
Operation should be one of:
  • 'C'
  • 'R'
  • 'U'
  • 'D'`

    this.LogMessage('error', occurrence, title, description)
  }

  LogUnknownTiming(timing, occurrence) {
    let title = `UNKNOWN TIMING: '${timing}'`
    let description = `
No timing exists with the name '${timing}'.
Timing should be one of:
  • 'before'
  • 'after'`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMixedType(modelName, key, field) {
    let occurrence = `processing the '${modelName}' model`
    let title = `MIXED TYPE FIELD: '${key}'`

    let description =  `
Fields in '${key}' won\'t be access checked and they won\'t appear in the robogo schema!
If you need those functionalities use the following syntax:

${key}: {
  type: new mongoose.Schema({
    key: value
  }),`

    if(field.name) description += `\n  name: ${field.name},`
    if(field.description) description += `\n  description: ${field.description},`
    description += `\n  ...
}

Instead of:

${key}: {
  type: {
    key: value
  },`
    if(field.name) description += `\n  name: ${field.name},`
    if(field.description) description += `\n  description: ${field.description},`
    description += `\n  ...
}`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogMiddlewareMessage(modelName, operation, timing, message) {
    let occurrence = `running the custom '${modelName} -> ${operation} -> ${timing}' middleware`
    let title = 'REQUEST STOPPED'

    let description = `
The custom '${modelName} -> ${operation} -> ${timing}' middleware stopped a request.
Given reason: '${message}'`

    this.LogMessage('log', occurrence, title, description)
  }
}

module.exports = Logger