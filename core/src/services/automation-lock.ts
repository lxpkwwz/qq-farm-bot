export {};

const { AsyncLocalStorage } = require('node:async_hooks');
const { createModuleLogger } = require('./logger');

const lockLogger = createModuleLogger('automation-lock');
const TIMEOUT_LOG_THROTTLE_MS = 30 * 1000;
let lastTimeoutLogAt = 0;

interface AutomationLockStore {
    exclusive: true;
    active: boolean;
}

interface QueueItem {
    name: string;
    fn: () => any;
    priority: boolean;
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timer: any;
}

const storage: any = new AsyncLocalStorage();
const queue: QueueItem[] = [];
let running = false;

/**
 * 显式等待队列取代原来的 Promise 尾链：语义完全一致（全局串行 + 持锁内联），
 * 但可以在队首插入高优先任务，也可以给「排队等锁」单独设超时。
 */
function pump(): void {
    if (running) return;
    const item = queue.shift();
    if (!item) return;
    running = true;
    if (item.timer) {
        clearTimeout(item.timer);
        item.timer = null;
    }
    const taskStore: AutomationLockStore = { exclusive: true, active: true };
    // 用 .then 包一层：taskFn 同步抛错时也要变成 rejected Promise，
    // 否则调用方惯用的 .catch(() => null) 接不住，异常会冒泡打断本轮调度。
    Promise.resolve()
        .then(() => storage.run(taskStore, item.fn))
        .then(
            (value: any) => item.resolve(value),
            (error: any) => item.reject(error),
        )
        .finally(() => {
            taskStore.active = false;
            running = false;
            pump();
        });
}

function runExclusiveAutomationTask<T>(
    taskName: string,
    taskFn: () => T | PromiseLike<T>,
    options: { detached?: boolean; priority?: boolean; timeoutMs?: number } = {},
): Promise<T> {
    const store: AutomationLockStore | undefined = storage.getStore();
    // 已经持锁（store.active）时一律就地执行，detached 也不例外：
    // detached 的用途只有一个 —— 定时器继承了**已结束**任务的异步上下文（active=false），
    // 那时必须重新排队。若持有者此刻正 await 这个 detached 子任务，重新排队会排到持有者
    // 自己后面，队列永远等不到它结束，整个进程的自动化全部卡死。就地执行最差只是少让一次锁。
    if (store && store.exclusive && (store.active || !options.detached)) return Promise.resolve().then(taskFn);

    return new Promise<T>((resolve, reject) => {
        const item: QueueItem = {
            name: String(taskName || 'automation'),
            fn: taskFn as () => any,
            priority: !!options.priority,
            resolve,
            reject,
            timer: null,
        };
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
        if (timeoutMs > 0) {
            item.timer = setTimeout(() => {
                const index = queue.indexOf(item);
                // 已经开始执行的任务不撤销：超时只管「排队等锁」这一段，
                // 不能让一个真在跑的任务被误判成没跑。
                if (index < 0) return;
                queue.splice(index, 1);
                const now = Date.now();
                if (now - lastTimeoutLogAt > TIMEOUT_LOG_THROTTLE_MS) {
                    lastTimeoutLogAt = now;
                    lockLogger.warn(`自动化任务 ${item.name} 排队超过 ${Math.round(timeoutMs / 1000)} 秒未拿到锁，本轮跳过`, {
                        module: 'system', event: '自动化锁等待', result: 'timeout', task: item.name,
                    });
                }
                resolve(undefined as T);
            }, timeoutMs);
        }
        if (item.priority) {
            // 插到所有低优先任务之前，但不打断正在执行的任务（它已不在队列里）。
            // 农场巡查 / 土地推送补跑因此可以越过排队中的长任务（卖果、活动自动化）。
            let insertAt = 0;
            while (insertAt < queue.length && queue[insertAt].priority) insertAt++;
            queue.splice(insertAt, 0, item);
        } else {
            queue.push(item);
        }
        pump();
    });
}

function isAutomationTaskRunning(): boolean {
    return running;
}

module.exports = {
    runExclusiveAutomationTask,
    isAutomationTaskRunning,
};
