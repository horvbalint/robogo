import type mongoose from 'mongoose'
import type { Request, Response } from 'express'

export type MaybePromise<T> = T | Promise<T>
export type FileMiddlewareFunction = (req: Request) => Promise<void>
export type AccessType = 'read' | 'write'
export type GuardFunction = (req: Request) => MaybePromise<boolean>
export type ServiceFunction = (req: Request, res: Response, data?: unknown) => unknown
export type MiddlewareTiming = 'before' | 'after'
export type OperationType = 'C' | 'R' | 'U' | 'D' | 'S'
export type MiddlewareBeforeFunction = (req: Request, res: Response) => Promise<void>
export type MiddlewareAfterFunction = (req: Request, res: Response, result: unknown) => Promise<void>
export interface NestedArray<T> extends Array<NestedArray<T> | T> {}
export interface RoboField<AccessGroup extends string = string> {
  /** The key of the field */
  key: string
  /** The name of the field */
  name: string
  /** The type of the field */
  type: string
  /** Indiciates whether the field is an array or not */
  isArray?: boolean
  /** Indiciates whether the field is required */
  required?: boolean
  /** A description provided to the field */
  description?: string
  /** Arbitrary data for the field */
  props: Record<string, unknown>
  /** A list of guard functions to be used for 'read' like operations */
  readGuards?: GuardFunction[]
  /** A list of guard functions to be used for 'write' like operations */
  writeGuards?: GuardFunction[]
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
  /** A list of access groups of which one is needed to read the fields content */
  readGroups?: AccessGroup[]
  /** A list of access groups of which one is needed to write the fields content */
  writeGroups?: AccessGroup[]
}

export interface Model<Namespace extends string, AccessGroup extends string> {
  /** The mongoose model instance */
  model: mongoose.Model<unknown>
  /** Name of the model */
  name: string
  /** Connected namespaces */
  namespaces: Namespace[]
  /** Arbitrary data for the model */
  props: Record<string, unknown>
  /** A list of access group variations by access type, if a user has every group in one of the variations, then they can read/write every field in the model */
  highestAccesses: null | Record<AccessType, AccessGroup[][]>
  /** A list of guard functions to be used for 'read' like operations */
  readGuards: GuardFunction[]
  /** A list of guard functions to be used for 'write' like operations */
  writeGuards: GuardFunction[]
  /** A filter object, where if no filter was provided in the request for the keys, then it will be supplied from this */
  defaultFilter: Record<string, unknown>
  /** A sort object, where if no sort was provided in the request for the keys, then it will be supplied from this */
  defaultSort: Record<string, unknown>
}
