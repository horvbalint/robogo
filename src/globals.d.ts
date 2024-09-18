import {GuardFunction, SortValue} from './types'

declare module 'mongoose' {
  interface SchemaOptions {
    name?: string 
    namespaces?: string[]
    props?: Record<string, unknown>
    readGuards?: GuardFunction[]
    writeGuards?: GuardFunction[]
    defaultFilter?: Record<string, unknown>
    defaultSort?: SortValue
    readGroups?: string[]
    writeGroups?: string[]
  }

  interface AnyObject {
    name?: string
  }
}

declare global {
  // Without this TS's Arra.isArray() does not work for readonly arrays :)))
  interface ArrayConstructor {
    isArray(arg: unknown): arg is unknown[] | readonly unknown[];
  }

  namespace Express {
    interface Request {
      accessGroups?: string[]
      checkReadAccess?: boolean
      checkWriteAccess?: boolean
    }
  }
}


export {}