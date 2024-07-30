import type mongoose from 'mongoose'
import type { Request, Response } from 'express'
import { ObjectId } from 'mongoose'

export type MaybePromise<T> = T | Promise<T>
export type FileMiddlewareFunction = (req: Request) => Promise<void>
export type AccessType = 'read' | 'write'
export type GuardFunction = (req: Request) => MaybePromise<boolean>
export type GuardPreCache = Map<GuardFunction, boolean>
export type ServiceFunction = (req: Request, res: Response, data?: unknown) => unknown
export type MiddlewareTiming = 'before' | 'after'
export type OperationType = 'C' | 'R' | 'U' | 'D' | 'S'
export type MiddlewareBeforeFunction = (req: Request, res: Response) => Promise<void>
export type MiddlewareAfterFunction = (req: Request, res: Response, result: unknown) => Promise<void>
export interface NestedArray<T> extends Array<NestedArray<T> | T> {}
export type SortValue = NonNullable<Parameters<mongoose.Query<unknown, unknown>['sort']>[0]>
export type SortObject = {
  [key: string]: mongoose.SortOrder | {
      $meta: any;
  }
}
export type FilterObject = {
  $and?: FilterObject[]
  $or?: FilterObject[]
  [key: string]: unknown
}
export interface MongooseDocument {
  _id: ObjectId
  [key: string]: unknown
}

export interface WithAccessGroups<AccessGroup extends string> {
  /** A list of access groups of which one is needed to read the content */
  readGroups?: AccessGroup[]
  /** A list of access groups of which one is needed to write the content */
  writeGroups?: AccessGroup[]
}

export interface RoboField<AccessGroup extends string = string> extends WithAccessGroups<AccessGroup> {
  /** The key of the field */
  key: string
  /** The type of the field */
  type: string
  /** The name of the field */
  name?: string
  /** Indiciates whether the field is an array or not */
  isArray?: boolean
  /** Indiciates whether the field is required */
  required?: boolean
  /** A description provided to the field */
  description?: string
  /** Arbitrary data for the field */
  props: Record<string, unknown>
  /** A list of guard functions to be used for 'read' like operations */
  readGuards: GuardFunction[]
  /** A list of guard functions to be used for 'write' like operations */
  writeGuards: GuardFunction[]
  /** Indiciates whether the field is marked TODO */
  marked?: boolean
  /** Indiciates whether the field is hidden TODO */
  hidden?: boolean
  /** Name of the model that the field references */
  ref?: string
  /** The mongoose enum field */
  enum?: unknown[]
  /** The mongoose-autopoulate field */
  autopopulate?: boolean | { maxDepth: number }
  /** The default value for the field */
  default?: unknown
  /** If the field is of type Object, then the descriptors of its fields */
  subfields?: RoboField<AccessGroup>[]
}

export interface Model<Namespace extends string, AccessGroup extends string> extends WithAccessGroups<AccessGroup> {
  /** The mongoose model instance */
  model: mongoose.Model<unknown>
  /** Name of the model */
  name?: string
  /** Connected namespaces */
  namespaces: Namespace[]
  /** Arbitrary data for the model */
  props: Record<string, unknown>
  /** A list of access group variations by access type, if a user has every group in one of the variations, then they can read/write every field in the model */
  minimalRequriedAccessGroupSets: null | Record<AccessType, AccessGroup[][]>
  /** A list of guard functions to be used for 'read' like operations */
  readGuards: GuardFunction[]
  /** A list of guard functions to be used for 'write' like operations */
  writeGuards: GuardFunction[]
  /** A filter object, where if no filter was provided in the request for the keys, then it will be supplied from this */
  defaultFilter: FilterObject
  /** A sort object, where if no sort was provided in the request for the keys, then it will be supplied from this */
  defaultSort: SortObject
}

export interface Accesses {
  model: {
    read: boolean
    write: boolean
    writeAllRequired: boolean
  }
  fields: Record<string, {
    read: boolean
    write: boolean
  }>
}