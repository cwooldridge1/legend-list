import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../setup";

import { doScrollTo } from "@/core/doScrollTo.native";
import { Platform } from "@/platform/Platform";
import { createMockContext } from "../__mocks__/createMockContext";

describe("doScrollTo (native)", () => {
    const originalPlatform = Platform.OS;

    beforeEach(() => {
        Platform.OS = originalPlatform;
    });

    afterEach(() => {
        Platform.OS = originalPlatform;
    });

    it("uses the Android RTL default before the native horizontal mode is detected", () => {
        Platform.OS = "android";
        const scrollTo = mock();
        const ctx = createMockContext(
            {
                totalSize: 1000,
            },
            {
                props: {
                    data: [],
                    horizontal: true,
                    rtl: true,
                },
                refScroller: {
                    current: {
                        scrollTo,
                    },
                } as any,
                scrollLength: 300,
            },
        );

        doScrollTo(ctx, { animated: true, horizontal: true, offset: 100 });

        expect(scrollTo).toHaveBeenCalledWith({ animated: true, x: 600, y: 0 });
        expect(ctx.state.horizontalRTLScrollType).toBeUndefined();
    });

    describe("an animated scroll native answers with no event", () => {
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

        beforeEach(() => {
            Platform.OS = "ios";
            globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            }) as typeof globalThis.requestAnimationFrame;
        });

        afterEach(() => {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        });

        const contextAt = (scroll: number, target: number) =>
            createMockContext(
                { totalSize: 1000 },
                {
                    hasScrolled: true,
                    props: { data: [] },
                    refScroller: { current: { scrollTo: mock() } } as any,
                    scroll,
                    scrollingTo: { animated: true, offset: target, targetOffset: target } as any,
                    scrollLength: 300,
                    scrollPending: scroll,
                },
            );

        it("finishes a scroll to the offset the list already rests at", () => {
            const ctx = contextAt(120, 120);

            doScrollTo(ctx, { animated: true, offset: 120 });

            expect(ctx.state.scrollingTo).toBeUndefined();
        });

        it("leaves a scroll to another offset for momentum end to finish", () => {
            const ctx = contextAt(120, 400);

            doScrollTo(ctx, { animated: true, offset: 400 });

            expect(ctx.state.scrollingTo).toBeDefined();
        });
    });

    it("uses the iOS RTL default before the native horizontal mode is detected", () => {
        Platform.OS = "ios";
        const scrollTo = mock();
        const ctx = createMockContext(
            {
                totalSize: 1000,
            },
            {
                props: {
                    data: [],
                    horizontal: true,
                    rtl: true,
                },
                refScroller: {
                    current: {
                        scrollTo,
                    },
                } as any,
                scrollLength: 300,
            },
        );

        doScrollTo(ctx, { animated: true, horizontal: true, offset: 100 });

        expect(scrollTo).toHaveBeenCalledWith({ animated: true, x: 600, y: 0 });
        expect(ctx.state.horizontalRTLScrollType).toBeUndefined();
    });
});
