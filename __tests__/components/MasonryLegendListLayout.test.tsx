import * as React from "react";

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ScrollAdjustHandler } from "../../src/core/ScrollAdjustHandler";
import type { StateContext } from "../../src/state/state";
import type { LegendListRef } from "../../src/types.base";
import TestRenderer, { act } from "../helpers/testRenderer";
import { registerBaseModuleMocks } from "../setup";

type Card = { height?: number; id: string };

const handlerInstances: ScrollAdjustHandler[] = [];
const requestedAdjusts: number[] = [];
let lastListProps: any;
let moduleCounter = 0;

const VIEWPORT = 300;

beforeEach(() => {
    mock.restore();
    registerBaseModuleMocks();
    mock.module("@/components/ListComponent", () => ({
        ListComponent: (props: any) => {
            lastListProps = props;
            return null;
        },
    }));
    mock.module("@/core/ScrollAdjustHandler", () => ({
        ScrollAdjustHandler: class {
            context: StateContext;
            constructor(ctx: StateContext) {
                this.context = ctx;
                handlerInstances.push(this as any);
            }
            requestAdjust(diff: number) {
                requestedAdjusts.push(diff);
            }
            setMounted() {}
            getAdjust() {
                return 0;
            }
            commitPendingAdjust() {}
        },
    }));
    handlerInstances.length = 0;
    requestedAdjusts.length = 0;
    lastListProps = undefined;
});

// Shortest column first, ties to the leftmost column.
function placeCards(heights: number[], numColumns: number, gap = 0) {
    const columnHeights = Array<number>(numColumns).fill(0);
    const tops: number[] = [];
    const columns: number[] = [];
    for (const height of heights) {
        let column = 0;
        for (let candidate = 1; candidate < numColumns; candidate++) {
            if (columnHeights[candidate] < columnHeights[column]) {
                column = candidate;
            }
        }
        tops.push(columnHeights[column]);
        columns.push(column + 1);
        columnHeights[column] += height + gap;
    }
    return { columnHeights, columns, tops };
}

function makeCards(count: number, heightAt: (index: number) => number): Card[] {
    return Array.from({ length: count }, (_, index) => ({ height: heightAt(index), id: `card-${index}` }));
}

async function loadMasonry() {
    moduleCounter++;
    const { LegendList } = await import(`../../src/components/LegendList?masonry-layout-core-${moduleCounter}`);
    mock.module("@legendapp/list/react-native", () => ({ LegendList }));
    const { MasonryLegendList } = await import(`../../src/integrations/masonry?masonry-layout-${moduleCounter}`);
    const { calculateItemsInView } = await import("../../src/core/calculateItemsInView");
    return { calculateItemsInView, MasonryLegendList };
}

type MountProps = Partial<React.ComponentProps<any>> & { data: Card[]; numColumns: number };

async function mountMasonry(initialProps: MountProps) {
    const { calculateItemsInView, MasonryLegendList } = await loadMasonry();
    const ref = React.createRef<LegendListRef>();
    const element = (props: MountProps) => (
        <MasonryLegendList
            drawDistance={0}
            estimatedItemSize={100}
            getFixedItemSize={(item: Card) => item.height}
            keyExtractor={(item: Card) => item.id}
            recycleItems
            ref={ref}
            renderItem={() => null}
            {...props}
        />
    );
    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    await act(async () => {
        renderer = TestRenderer.create(element(initialProps));
    });
    await act(async () => {
        lastListProps?.onLayout?.({ nativeEvent: { layout: { height: VIEWPORT, width: 320, x: 0, y: 0 } } });
    });
    const ctx = (handlerInstances.at(-1) as any).context as StateContext;
    ctx.state.didContainersLayout = true;

    const scrollTo = async (scroll: number) => {
        await act(async () => {
            ctx.state.scroll = scroll;
            ctx.state.scrollHistory.length = 0;
            calculateItemsInView(ctx);
        });
    };
    const update = async (props: MountProps) => {
        await act(async () => {
            renderer?.update(element(props));
        });
    };
    const unmount = async () => {
        await act(async () => {
            renderer?.unmount();
        });
    };
    const positions = (count: number) => Array.from({ length: count }, (_, index) => ctx.state.positions[index]);
    const missingVisible = (cards: Card[], heights: number[], numColumns: number, scroll: number) => {
        const { tops } = placeCards(heights, numColumns);
        return cards
            .filter((_card, index) => tops[index] + heights[index] > scroll && tops[index] < scroll + VIEWPORT)
            .filter((card) => !ctx.state.containerItemKeys.has(card.id))
            .map((card) => card.id);
    };
    return { ctx, missingVisible, positions, ref, scrollTo, unmount, update };
}

// From the requirement: the range can change only when the top edge reaches the bottom of a
// column's last item above it, or the bottom edge reaches the top of a column's next item.
function expectedWindow(heights: number[], numColumns: number, top: number, bottom: number) {
    const { columns, tops } = placeCards(heights, numColumns);
    let nextTop: number | null = null;
    let nextBottom: number | null = null;
    for (let column = 1; column <= numColumns; column++) {
        const indices = heights.map((_, index) => index).filter((index) => columns[index] === column);
        const above = indices.filter((index) => tops[index] + heights[index] <= top);
        if (above.length > 0) {
            const edge = Math.max(...above.map((index) => tops[index] + heights[index]));
            nextTop = nextTop === null ? edge : Math.max(nextTop, edge);
        }
        const below = indices.filter((index) => tops[index] > bottom);
        if (below.length > 0) {
            const edge = Math.min(...below.map((index) => tops[index]));
            nextBottom = nextBottom === null ? edge : Math.min(nextBottom, edge);
        }
    }
    return { bottom: nextBottom, top: nextTop };
}

describe("MasonryLegendList layout", () => {
    it("breaks ties toward the leftmost column", async () => {
        const cards = makeCards(7, () => 100);
        const list = await mountMasonry({ data: cards, numColumns: 3 });

        expect(list.positions(7)).toEqual([0, 0, 0, 100, 100, 100, 200]);
        expect(list.ctx.state.columns.slice(0, 7)).toEqual([1, 2, 3, 1, 2, 3, 1]);
        await list.unmount();
    });

    it("places mixed heights in the shortest column", async () => {
        const heights = [120, 40, 40, 200, 30, 90, 10, 150, 60, 70];
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 3 });
        const expected = placeCards(heights, 3);

        expect(list.positions(heights.length)).toEqual(expected.tops);
        expect(list.ctx.state.columns.slice(0, heights.length)).toEqual(expected.columns);
        expect(list.ref.current?.getState().contentLength).toBe(Math.max(...expected.columnHeights));
        await list.unmount();
    });

    it("renders exactly the cards that intersect the range in each column", async () => {
        const heights = Array.from({ length: 60 }, (_, index) => 60 + ((index * 53) % 170));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 3 });
        const { tops } = placeCards(heights, 3);

        await list.scrollTo(700);

        const intersecting = cards
            .filter((_, index) => tops[index] + heights[index] > 700 && tops[index] <= 700 + VIEWPORT)
            .map((card) => card.id)
            .sort();
        expect([...list.ctx.state.containerItemKeys.keys()].sort()).toEqual(intersecting);
        await list.unmount();
    });

    it("caches the nearest column edge on each side of the range", async () => {
        const heights = Array.from({ length: 80 }, (_, index) => 50 + ((index * 71) % 230));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });

        for (const scroll of [400, 1300, 900, 2500]) {
            await list.scrollTo(scroll);
            expect(list.ctx.state.scrollForNextCalculateItemsInView).toEqual(
                expectedWindow(heights, 2, scroll, scroll + VIEWPORT),
            );
        }
        await list.unmount();
    });

    it("does no range work while scrolling inside the window and resumes at its edges", async () => {
        const heights = Array.from({ length: 80 }, (_, index) => 50 + ((index * 71) % 230));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });
        const strategy = list.ctx.state.props.layoutStrategyInternal!;
        const findStartIndex = spyOn(strategy, "findStartIndex");

        await list.scrollTo(1300);
        const window = list.ctx.state.scrollForNextCalculateItemsInView!;
        expect(window.top).not.toBeNull();
        expect(window.bottom).not.toBeNull();
        const callsAtRest = findStartIndex.mock.calls.length;

        await list.scrollTo(Math.ceil((window.top! + 1 + 1300) / 2));
        await list.scrollTo(Math.floor((1300 + window.bottom! - VIEWPORT - 1) / 2));
        expect(findStartIndex.mock.calls.length).toBe(callsAtRest);

        await list.scrollTo(window.bottom! - VIEWPORT);
        expect(findStartIndex.mock.calls.length).toBe(callsAtRest + 1);
        expect(list.missingVisible(cards, heights, 2, window.bottom! - VIEWPORT)).toEqual([]);

        await list.scrollTo(window.top! + 1);
        const nextWindow = list.ctx.state.scrollForNextCalculateItemsInView!;
        await list.scrollTo(nextWindow.top!);
        expect(list.missingVisible(cards, heights, 2, nextWindow.top!)).toEqual([]);
        findStartIndex.mockRestore();
        await list.unmount();
    });

    it("never misses a visible card across a long scroll walk, and skips most steps", async () => {
        const heights = Array.from({ length: 400 }, (_, index) => 40 + ((index * 97) % 260));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 3 });
        const strategy = list.ctx.state.props.layoutStrategyInternal!;
        const findStartIndex = spyOn(strategy, "findStartIndex");
        const maxScroll = Math.max(...placeCards(heights, 3).columnHeights) - VIEWPORT;

        let scroll = 0;
        let seed = 7;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const steps = 600;
        for (let step = 0; step < steps; step++) {
            const isJump = random() < 0.03;
            const delta = isJump ? (random() - 0.5) * 6000 : (random() - 0.45) * 40;
            scroll = Math.round(Math.max(0, Math.min(maxScroll, scroll + delta)));
            await list.scrollTo(scroll);
            expect(list.missingVisible(cards, heights, 3, scroll)).toEqual([]);
        }

        expect(findStartIndex.mock.calls.length).toBeLessThan(steps / 2);
        expect(list.ctx.values.get("numContainers")).toBeLessThanOrEqual(40);
        findStartIndex.mockRestore();
        await list.unmount();
    });

    it("reflows a mix of fixed and measured cards as measurements arrive", async () => {
        const heights = [120, 80, 140, 60, 100, 90, 130, 70];
        const isMeasured = (index: number) => index % 3 === 1;
        const cards = heights.map((height, index) => ({
            height: isMeasured(index) ? undefined : height,
            id: `card-${index}`,
        }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });
        const estimated = heights.map((height, index) => (isMeasured(index) ? 100 : height));
        expect(list.positions(heights.length)).toEqual(placeCards(estimated, 2).tops);

        const measured = [...estimated];
        for (const index of [4, 1, 7]) {
            await act(async () => {
                list.ref.current?.setItemSize(`card-${index}`, { height: heights[index], width: 160 });
            });
            measured[index] = heights[index];
            expect(list.positions(heights.length)).toEqual(placeCards(measured, 2).tops);
        }

        await list.scrollTo(150);
        await list.scrollTo(0);
        expect(list.positions(heights.length)).toEqual(placeCards(heights, 2).tops);

        await act(async () => {
            list.ref.current?.setItemSize("card-1", { height: 300, width: 160 });
        });
        const remeasured = [...heights];
        remeasured[1] = 300;
        expect(list.positions(heights.length)).toEqual(placeCards(remeasured, 2).tops);
        await list.unmount();
    });

    it("rebalances when numColumns changes and back", async () => {
        const heights = Array.from({ length: 40 }, (_, index) => 60 + ((index * 37) % 140));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });
        await list.scrollTo(500);

        await list.update({ data: cards, numColumns: 3 });
        expect(list.positions(heights.length)).toEqual(placeCards(heights, 3).tops);
        await list.scrollTo(400);
        expect(list.missingVisible(cards, heights, 3, 400)).toEqual([]);

        await list.update({ data: cards, numColumns: 2 });
        expect(list.positions(heights.length)).toEqual(placeCards(heights, 2).tops);
        await list.scrollTo(450);
        expect(list.missingVisible(cards, heights, 2, 450)).toEqual([]);
        await list.unmount();
    });

    it("swaps the whole data set without keeping the old cards", async () => {
        const first = makeCards(50, (index) => 80 + ((index * 41) % 120));
        const list = await mountMasonry({ data: first, numColumns: 2 });
        await list.scrollTo(600);

        const secondHeights = Array.from({ length: 30 }, (_, index) => 50 + ((index * 29) % 200));
        const second = secondHeights.map((height, index) => ({ height, id: `other-${index}` }));
        await list.update({ data: second, numColumns: 2 });
        await list.scrollTo(200);

        expect(list.positions(second.length)).toEqual(placeCards(secondHeights, 2).tops);
        expect([...list.ctx.state.containerItemKeys.keys()].every((key) => key.startsWith("other-"))).toBe(true);
        expect(list.missingVisible(second, secondHeights, 2, 200)).toEqual([]);
        await list.unmount();
    });

    it("re-reads a card's fixed height when its data changes, even off screen", async () => {
        const heights = Array.from({ length: 40 }, () => 100);
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });

        const nextHeights = [...heights];
        nextHeights[30] = 260;
        const nextCards = cards.map((card, index) => (index === 30 ? { ...card, height: 260 } : card));
        await list.update({ data: nextCards, numColumns: 2 });

        expect(list.ctx.state.containerItemKeys.has("card-30")).toBe(false);
        expect(list.positions(nextHeights.length)).toEqual(placeCards(nextHeights, 2).tops);
        expect(list.ref.current?.getState().contentLength).toBe(Math.max(...placeCards(nextHeights, 2).columnHeights));
        await list.unmount();
    });

    it("takes a fixed height a card gains after it was estimated, even off screen", async () => {
        const heights = Array.from({ length: 40 }, (_, index) => 60 + ((index * 37) % 140));
        const unsized = heights.map((_, index) => ({ id: `card-${index}` }));
        const list = await mountMasonry({ data: unsized, numColumns: 2 });
        expect(list.positions(heights.length)).toEqual(
            placeCards(
                heights.map(() => 100),
                2,
            ).tops,
        );

        const sized = heights.map((height, index) => ({ height, id: `card-${index}` }));
        await list.update({ data: sized, numColumns: 2 });

        expect(list.ctx.state.containerItemKeys.has("card-30")).toBe(false);
        expect(list.positions(heights.length)).toEqual(placeCards(heights, 2).tops);
        expect(list.ref.current?.getState().contentLength).toBe(Math.max(...placeCards(heights, 2).columnHeights));
        await list.unmount();
    });

    it("does not anchor the first visible card when data changes", async () => {
        const cards = makeCards(60, (index) => 80 + ((index * 41) % 120));
        const list = await mountMasonry({ data: cards, maintainVisibleContentPosition: false, numColumns: 2 });
        await list.scrollTo(900);

        await list.update({
            data: [{ height: 300, id: "new" }, ...cards],
            maintainVisibleContentPosition: false,
            numColumns: 2,
        });

        expect(requestedAdjusts).toEqual([]);
        expect(list.ctx.state.scroll).toBe(900);
        await list.unmount();
    });

    it("fills the range when the header shrinks without a scroll", async () => {
        const { setHeaderSize } = await import("../../src/core/updateContentMetrics");
        const heights = Array.from({ length: 30 }, (_, index) => 60 + ((index * 37) % 140));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });
        await list.scrollTo(1200);
        await act(async () => {
            setHeaderSize(list.ctx, 600);
        });
        await list.scrollTo(0);

        for (const size of [450, 200, 0]) {
            await act(async () => {
                setHeaderSize(list.ctx, size);
            });
            expect(list.missingVisible(cards, heights, 2, -size)).toEqual([]);
        }
        await list.unmount();
    });

    it("renders the first rows at a negative resting offset", async () => {
        const heights = Array.from({ length: 30 }, (_, index) => 60 + ((index * 37) % 140));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ data: cards, numColumns: 2 });

        await list.scrollTo(-120);

        expect(list.missingVisible(cards, heights, 2, 0)).toEqual([]);
        expect(list.ctx.state.scrollForNextCalculateItemsInView?.top ?? null).toBeNull();
        await list.unmount();
    });

    it("starts and scrolls back to the resting offset under a top inset", async () => {
        const heights = Array.from({ length: 30 }, (_, index) => 60 + ((index * 37) % 140));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({
            contentInset: { bottom: 0, left: 0, right: 0, top: 96 },
            data: cards,
            initialScrollOffset: -96,
            numColumns: 2,
        });
        expect(lastListProps.initialContentOffset).toBe(-96);

        await list.scrollTo(600);
        await act(async () => {
            void list.ref.current?.scrollToOffset({ animated: false, offset: -96 });
        });

        expect(list.ctx.state.scroll).toBe(-96);
        expect(list.missingVisible(cards, heights, 2, 0)).toEqual([]);
        await list.unmount();
    });

    it("offsets the range by contentContainerStyle padding", async () => {
        const heights = Array.from({ length: 30 }, (_, index) => 60 + ((index * 37) % 140));
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        const list = await mountMasonry({ contentContainerStyle: { paddingTop: 80 }, data: cards, numColumns: 2 });

        await list.scrollTo(480);

        expect(list.missingVisible(cards, heights, 2, 400)).toEqual([]);
        await list.unmount();
    });

    it("places nothing for empty data and fills in when data arrives", async () => {
        const list = await mountMasonry({ data: [], numColumns: 2 });
        expect(list.ref.current?.getState().contentLength).toBe(0);

        const heights = [100, 50, 70];
        const cards = heights.map((height, index) => ({ height, id: `card-${index}` }));
        await list.update({ data: cards, numColumns: 2 });

        expect(list.positions(3)).toEqual(placeCards(heights, 2).tops);
        await list.unmount();
    });

    it("passes the refresh control through to the scroll view", async () => {
        const refreshControl = <React.Fragment key="refresh" />;
        const list = await mountMasonry({
            data: makeCards(4, () => 100),
            numColumns: 2,
            refreshControl,
            refreshing: true,
        });

        expect(lastListProps.refreshControl).toBe(refreshControl);
        await list.unmount();
    });

    it("forwards onScroll", async () => {
        const onScroll = mock(() => {});
        const cards = makeCards(30, () => 100);
        const list = await mountMasonry({ data: cards, numColumns: 2, onScroll });

        await act(async () => {
            lastListProps.onScroll({
                nativeEvent: {
                    contentOffset: { x: 0, y: 250 },
                    contentSize: { height: 1500, width: 320 },
                    layoutMeasurement: { height: VIEWPORT, width: 320 },
                },
            });
        });

        expect(onScroll).toHaveBeenCalledTimes(1);
        expect(list.ctx.state.scroll).toBe(250);
        await list.unmount();
    });
});
