/**
 * 创建可由测试显式完成的异步信号。
 *
 * @remarks
 * 超时由测试运行器统一负责，使用显式完成信号避免轮询和固定延时。
 *
 * @typeParam T - 信号完成时携带的值类型。
 * @returns 待完成的 Promise 及其完成函数。
 */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
