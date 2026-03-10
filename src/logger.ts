type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/* eslint-disable no-console */
export class Logger {
    #level: number;

    constructor(level: LogLevel = "info") {
        this.#level = LEVELS[level];
    }

    debug(message: string): void {
        if (this.#level <= LEVELS.debug) {
            console.debug(`[Enkryptify] ${message}`);
        }
    }

    info(message: string): void {
        if (this.#level <= LEVELS.info) {
            console.info(`[Enkryptify] ${message}`);
        }
    }

    warn(message: string): void {
        if (this.#level <= LEVELS.warn) {
            console.warn(`[Enkryptify] ${message}`);
        }
    }

    error(message: string): void {
        if (this.#level <= LEVELS.error) {
            console.error(`[Enkryptify] ${message}`);
        }
    }
}
