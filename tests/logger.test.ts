import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "@/logger";

describe("Logger", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("respects log level filtering — debug hidden at info level", () => {
        const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const logger = new Logger("info");
        logger.debug("test");
        expect(spy).not.toHaveBeenCalled();
    });

    it("shows debug messages at debug level", () => {
        const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const logger = new Logger("debug");
        logger.debug("test");
        expect(spy).toHaveBeenCalledOnce();
    });

    it("calls correct console method per level", () => {
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const logger = new Logger("debug");
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        expect(debugSpy).toHaveBeenCalledOnce();
        expect(infoSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("prefixes messages with [Enkryptify]", () => {
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const logger = new Logger("info");
        logger.info("hello");
        expect(spy).toHaveBeenCalledWith("[Enkryptify] hello");
    });

    it("error level hides info and warn messages", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const logger = new Logger("error");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        expect(infoSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledOnce();
    });
});
