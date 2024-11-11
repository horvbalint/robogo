/** A collection of sets that removes every inserted set which is a superset of any other stored set */
export default class MinimalSetCollection<T> {
    array: Set<T>[];
    /** insert a set into the collection if it is not a superset of one of the already stored sets */
    insert(set: Set<T>): void;
    /**
     * Get a reference to the underlying array
     * DO NOT modify this array, modifications will mess up the collection
     */
    getArray(): Set<T>[];
    private isSetSubsetOf;
}
