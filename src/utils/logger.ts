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
  logMessage(type: string, occurrence: string, title: string, description: string) {
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

  logUnknownReference(modelName: string, fieldKey: string, referencedModel: string, occurrence: string) {
    const title = `UNKNOWN REFERENCE: '${referencedModel}'`
    const description = `
There is an unknown model '${referencedModel}' referenced in the field '${fieldKey}' of the model '${modelName}'.
This might be intentional, if not, declare the missing model or check, if:

  • the name of the model contains a typo
  • the file containg the model is in the folder which was given to robogo
  • the file is exporting the model, so robogo can import it`

    this.logMessage('warning', occurrence, title, description)
  }

  logIncorrectAdminGroups(adminGroups: unknown, occurrence: string) {
    const title = `INCORRECT ADMIN GROUPS: '${adminGroups}'`
    const description = `
The admin groups property '${adminGroups}' has a wrong type.
The admin groups property's type should be one of:
  • Array (eg.: ['adminGroup1', 'adminGroup2'])
  • Object (eg.: {adminGroup1: ['namespace1', 'namespace2'], adminGroup2: ['namespace1']})`

    this.logMessage('warning', occurrence, title, description)
  }

  logMissingModel(modelName: string, occurrence: string) {
    const title = `MISSING MODEL: '${modelName}'`
    const description = `
There is no model registered with the name '${modelName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the model is in the folder which was given to robogo
  • the file is exporting the model, so robogo can import it`

    this.logMessage('error', occurrence, title, description)
  }

  logMissingService(serviceName: string, occurrence: string) {
    const title = `MISSING SERVICE: '${serviceName}'`
    const description = `
There is no service registered with the name '${serviceName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the file containg the service is in the folder which was given to robogo
  • the file is exporting the service, so robogo can import it`

    this.logMessage('error', occurrence, title, description)
  }

  logMissingServiceFunction(serviceName: string, functionName: string, occurrence: string) {
    const title = `MISSING SERVICE FUNCTION: '${functionName}'`
    const description = `
There is no function in the service '${serviceName}' with the name '${functionName}'.
This is most likely just a typo.

If the name is correct check, if:
  • the '${serviceName}' service is the one containing the function`

    this.logMessage('error', occurrence, title, description)
  }

  logUnknownOperation(operation: string, occurrence: string) {
    const title = `UNKNOWN OPERATION: '${operation}'`
    const description = `
No operation exists with the name '${operation}'.
Operation should be one of:
  • 'C'
  • 'R'
  • 'U'
  • 'D'`

    this.logMessage('error', occurrence, title, description)
  }

  logUnknownTiming(timing: MiddlewareTiming, occurrence: string) {
    const title = `UNKNOWN TIMING: '${timing}'`
    const description = `
No timing exists with the name '${timing}'.
Timing should be one of:
  • 'before'
  • 'after'`

    this.logMessage('error', occurrence, title, description)
  }


  logMiddlewareMessage(modelName: string, operation: string, timing: MiddlewareTiming, message: string) {
    const occurrence = `running the custom '${modelName} -> ${operation} -> ${timing}' middleware`
    const title = 'REQUEST STOPPED'

    const description = `
The custom '${modelName} -> ${operation} -> ${timing}' middleware stopped a request.
Given reason: '${message}'`

    this.logMessage('log', occurrence, title, description)
  }

  logUnknownAccessGroupInField(modelName: string, fieldKey: string, accessGroup: string, occurrence: string) {
    const title = `UNKNOWN ACCESS GROUP: '${accessGroup}'`
    const description = `
There is an unknown access group '${accessGroup}' used in the field '${fieldKey}' of the model '${modelName}'.
This is most likely just a typo, if not, please add the group to the array of declared access groups in the constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }

  logUnknownAccessGroupInModel(modelName: string, accessGroup: string, occurrence: string) {
    const title = `UNKNOWN ACCESS GROUP: '${accessGroup}'`
    const description = `
There is an unknown access group '${accessGroup}' used in the model '${modelName}'.
This is most likely just a typo, if not, please add the group to the array of declared access groups in the constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }

  logIncorrectAccessGroupNamespaceInField(modelName: string, fieldKey: string, accessGroup: string, accessGroupNamespaces: readonly string[], modelNamespaces: readonly string[], occurrence: string) {
    const title = `INCORRECT ACCESS GROUP: '${accessGroup}'`
    const description = `
The access group '${accessGroup}' is used in the field '${fieldKey}' of the model '${modelName}', but they are not meant to be used with each other.
The model has the following associated namespaces: ${modelNamespaces},
while the access group is meant to be used with the following namespaces: ${accessGroupNamespaces}.
This is likely an issue, if not, please add one of the model's namespaces to the access group's possible namespace list in constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }

  logIncorrectAccessGroupNamespaceInModel(modelName: string, accessGroup: string, accessGroupNamespaces: readonly string[], modelNamespaces: readonly string[], occurrence: string) {
    const title = `INCORRECT ACCESS GROUP: '${accessGroup}'`
    const description = `
The access group '${accessGroup}' is used in the model '${modelName}', but they are not meant to be used with each other.
The model has the following associated namespaces: ${modelNamespaces},
while the access group is meant to be used with the following namespaces: ${accessGroupNamespaces}.
This is likely an issue, if not, please add one of the model's namespaces to the access group's possible namespace list in constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }

  logUnknownNamespaceInModel(modelName: string, namespace: string, occurrence: string) {
    const title = `UNKNOWN NAMESPACE: '${namespace}'`
    const description = `
There is an unknown namespace '${namespace}' used in the model '${modelName}'.
This is most likely just a typo, if not, please add the namespace to the array of declared namespaces in the constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }

  logUnknownNamespaceInAccessGroup(accessGroup: string, namespace: string, occurrence: string) {
    const title = `UNKNOWN NAMESPACE: '${namespace}'`
    const description = `
There is an unknown namespace '${namespace}' used in the access group '${accessGroup}'.
This is most likely just a typo, if not, please add the namespace to the array of declared namespaces in the constructor of robogo.`

    this.logMessage('warning', occurrence, title, description)
  }
}
