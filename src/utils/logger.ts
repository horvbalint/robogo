/* eslint-disable no-console */

import type { MiddlewareTiming, RoboField } from '../types'

interface ConstructorParams {
  showErrors: boolean
  showWarnings: boolean
  showLogs: boolean
}

export default class Logger {
  private showErrors: boolean
  private showWarnings: boolean
  private showLogs: boolean

  constructor({ showErrors, showWarnings, showLogs }: ConstructorParams) {
    this.showErrors = showErrors
    this.showWarnings = showWarnings
    this.showLogs = showLogs
  }

  // The functions below are the logs of robogo, they are formatted using bash sequences.
  // Colors and formattings can be found at: https://misc.flogisoft.com/bash/tip_colors_and_formatting
  // \e[ should be changed to \x1b[ to work with Node.js
  /**
   * @param {'error' | 'warning' | 'log'} type
   * @param {string} occurrence
   * @param {string} title
   * @param {string} description
   */
  LogMessage(type: string, occurrence: string, title: string, description: string) {
    let mainTitle, color

    if (type === 'error') {
      if (!this.showErrors)
        return
      mainTitle = 'ROBOGO ERROR'
      color = 91
    }
    else if (type === 'warning') {
      if (!this.showWarnings)
        return
      mainTitle = 'ROBOGO WARNING'
      color = 93
    }
    else if (type === 'log') {
      if (!this.showLogs)
        return
      mainTitle = 'ROBOGO LOG'
      color = 34
    }

    console.log(`\x1B[${color}m\x1B[7m\x1B[1m%s\x1B[0m`, `\n ${mainTitle} `)
    console.log(`\x1B[${color}m%s\x1B[0m`, `occurred while ${occurrence}.\n`)
    console.log(`\x1B[${color}m\x1B[1m%s\x1B[0m`, title)
    console.log(`\x1B[${color}m%s\x1B[0m`, description, '\n')
  }

  LogUnknownReference(modelName: string, fieldKey: string, referencedModel: string, occurrence: string) {
    const title = `UNKNOWN REFERENCE: '${referencedModel}'`
    const description = `
There is an unknown model '${referencedModel}' referenced in the field '${fieldKey}' of the model '${modelName}'.
This might be intentional, if not, declare the missing model or check, if:

  • the name of the model contains a typo
  • the file containg the model is in the folder which was given to robogo
  • the file is exporting the model, so robogo can import it`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogIncorrectAdminGroups(adminGroups: unknown, occurrence: string) {
    const title = `INCORRECT ADMIN GROUPS: '${adminGroups}'`
    const description = `
The admin groups property '${adminGroups}' has a wrong type.
The admin groups property's type should be one of:
  • Array (eg.: ['adminGroup1', 'adminGroup2'])
  • Object (eg.: {adminGroup1: ['namespace1', 'namespace2'], adminGroup2: ['namespace1']})`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogMissingModel(modelName: string, occurrence: string) {
    const title = `MISSING MODEL: '${modelName}'`
    const description = `
There is no model registered with the name '${modelName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the model is in the folder which was given to robogo
  • the file is exporting the model, so robogo can import it`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMissingService(serviceName: string, occurrence: string) {
    const title = `MISSING SERVICE: '${serviceName}'`
    const description = `
There is no service registered with the name '${serviceName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the service is in the folder which was given to robogo
  • the file is exporting the service, so robogo can import it`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMissingServiceFunction(serviceName: string, functionName: string, occurrence: string) {
    const title = `MISSING SERVICE FUNCTION: '${functionName}'`
    const description = `
There is no function in the service '${serviceName}' with the name '${functionName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the '${serviceName}' service is the one containing the function`

    this.LogMessage('error', occurrence, title, description)
  }

  LogUnknownOperation(operation: string, occurrence: string) {
    const title = `UNKNOWN OPERATION: '${operation}'`
    const description = `
No operation exists with the name '${operation}'.
Operation should be one of:
  • 'C'
  • 'R'
  • 'U'
  • 'D'`

    this.LogMessage('error', occurrence, title, description)
  }

  LogUnknownTiming(timing: MiddlewareTiming, occurrence: string) {
    const title = `UNKNOWN TIMING: '${timing}'`
    const description = `
No timing exists with the name '${timing}'.
Timing should be one of:
  • 'before'
  • 'after'`

    this.LogMessage('error', occurrence, title, description)
  }

  LogMixedType(modelName: string, key: string, field: RoboField) {
    const occurrence = `processing the '${modelName}' model`
    const title = `MIXED TYPE FIELD: '${key}'`

    let description = `
Fields in '${key}' won\'t be access checked and they won\'t appear in the robogo schema!
If you need those functionalities use the following syntax:

${key}: {
  type: new mongoose.Schema({
    key: value
  }),`

    if (field.name)
      description += `\n  name: ${field.name},`
    if (field.description)
      description += `\n  description: ${field.description},`
    description += `\n  ...
}

Instead of:

${key}: {
  type: {
    key: value
  },`
    if (field.name)
      description += `\n  name: ${field.name},`
    if (field.description)
      description += `\n  description: ${field.description},`
    description += `\n  ...
}`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogMiddlewareMessage(modelName: string, operation: string, timing: MiddlewareTiming, message: string) {
    const occurrence = `running the custom '${modelName} -> ${operation} -> ${timing}' middleware`
    const title = 'REQUEST STOPPED'

    const description = `
The custom '${modelName} -> ${operation} -> ${timing}' middleware stopped a request.
Given reason: '${message}'`

    this.LogMessage('log', occurrence, title, description)
  }

  LogUnknownAccessGroupInField(modelName: string, fieldKey: string, accessGroup: string, occurrence: string) {
    const title = `UNKNOWN ACCESS GROUP: '${accessGroup}'`
    const description = `
There is an unknown access group '${accessGroup}' used in the field '${fieldKey}' of the model '${modelName}'.
This is most likely just a typo, if not, please add the group to the array of declared access groups in the constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogUnknownAccessGroupInModel(modelName: string, accessGroup: string, occurrence: string) {
    const title = `UNKNOWN ACCESS GROUP: '${accessGroup}'`
    const description = `
There is an unknown access group '${accessGroup}' used in the model '${modelName}'.
This is most likely just a typo, if not, please add the group to the array of declared access groups in the constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogIncorrectAccessGroupNamespaceInField(modelName: string, fieldKey: string, accessGroup: string, accessGroupNamespaces: string, modelNamespaces: string, occurrence: string) {
    const title = `INCORRECT ACCESS GROUP: '${accessGroup}'`
    const description = `
The access group '${accessGroup}' is used in the field '${fieldKey}' of the model '${modelName}', but they are not meant to be used with each other.
The model has the following associated namespaces: ${modelNamespaces},
while the access group is meant to be used with the following namespaces: ${accessGroupNamespaces}.
This is likely an issue, if not, please add one of the model's namespaces to the access group's possible namespace list in constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogIncorrectAccessGroupNamespaceInModel(modelName: string, accessGroup: string, accessGroupNamespaces: string, modelNamespaces: string, occurrence: string) {
    const title = `INCORRECT ACCESS GROUP: '${accessGroup}'`
    const description = `
The access group '${accessGroup}' is used in the model '${modelName}', but they are not meant to be used with each other.
The model has the following associated namespaces: ${modelNamespaces},
while the access group is meant to be used with the following namespaces: ${accessGroupNamespaces}.
This is likely an issue, if not, please add one of the model's namespaces to the access group's possible namespace list in constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogUnknownNamespaceInModel(modelName: string, namespace: string, occurrence: string) {
    const title = `UNKNOWN NAMESPACE: '${namespace}'`
    const description = `
There is an unknown namespace '${namespace}' used in the model '${modelName}'.
This is most likely just a typo, if not, please add the namespace to the array of declared namespaces in the constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }

  LogUnknownNamespaceInAccessGroup(accessGroup: string, namespace: string, occurrence: string) {
    const title = `UNKNOWN NAMESPACE: '${namespace}'`
    const description = `
There is an unknown namespace '${namespace}' used in the access group '${accessGroup}'.
This is most likely just a typo, if not, please add the namespace to the array of declared namespaces in the constructor of robogo.`

    this.LogMessage('warning', occurrence, title, description)
  }
}
