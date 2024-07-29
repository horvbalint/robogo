/** A collection of sets that removes every inserted set which is a superset of any other stored set */
export default class MinimalSetCollection<T> {
  array: Set<T>[] = []

  /** insert a set into the collection if it is not a superset of one of the already stored sets */
  insert(set: Set<T>) {
    let lastIndexWithThisSize = 0

    if (this.array.length) {
      // visit the stored sets until we find the correct place in the array by set size, if we found a subset of this set, return/
      while (lastIndexWithThisSize < this.array.length && this.array[lastIndexWithThisSize].size <= set.size) {
        if (this.isSetSubsetOf(this.array[lastIndexWithThisSize], set))
          return

        lastIndexWithThisSize++
      }

      // visit the stored sets that are longer then the new set, and remove those which are the superset of the new set
      for (let i = lastIndexWithThisSize; i < this.array.length; ++i) {
        if (this.isSetSubsetOf(set, this.array[i])) {
          this.array.splice(i, 1)
          --i
        }
      }
    }

    this.array.splice(lastIndexWithThisSize, 0, set)
  }

  /**
   * Get a reference to the underlying array
   * DO NOT modify this array, modifications will mess up the collection
   */
  getArray() {
    return this.array
  }

  private isSetSubsetOf(one: Set<T>, other: Set<T>) {
    for (const item of one) {
      if (!other.has(item))
        return false
    }

    return true
  }
}
