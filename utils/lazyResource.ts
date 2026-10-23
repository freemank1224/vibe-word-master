/** Share one in-flight load, but let a later call retry after a network failure. */
export function createLazyResource<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(load).catch(error => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
