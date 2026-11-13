import * as React from "react";

import { LegendList, type LegendListProps, type LegendListRef } from "@legendapp/list/react-native";

type MasonryLegendListProps<ItemT = any> = Omit<LegendListProps<ItemT>, "horizontal" | "overrideItemLayout"> & {
    numColumns: number;
};

type MasonryLegendListComponentType = <ItemT = any>(
    props: MasonryLegendListProps<ItemT> & React.RefAttributes<LegendListRef>,
) => React.ReactElement | null;

type MasonryLayoutState = {
    columns: number[];
    columnSpans: number[];
    idCache: string[];
    indexByKey: Map<string, number>;
    minIndexSizeChanged: number | undefined;
    positions: number[];
    props: {
        data: readonly unknown[];
        getFixedItemSize: ((item: any, index: number, type: any) => number | undefined) | undefined;
        getItemType: ((item: any, index: number) => unknown) | undefined;
    };
    scrollAdjustHandler: {
        getAdjust: () => number;
    };
    scrollingTo?: unknown;
    sizes: Map<string, number>;
    sizesKnown: Map<string, number>;
};

type MasonryLayoutContext = {
    positionListeners: {
        size: number;
    };
    scrollAxisGap: number;
    state: MasonryLayoutState;
    values: {
        get: (key: string) => unknown;
    };
};

type MasonryLayoutDependencies = {
    getId: (state: MasonryLayoutState, index: number) => string;
    getItemSize: (
        ctx: MasonryLayoutContext,
        key: string,
        index: number,
        item: unknown,
        useAverageSize?: boolean,
        preferCachedSize?: boolean,
        notifyTotalSize?: boolean,
    ) => number;
    getScrollVelocity: (state: MasonryLayoutState) => number;
    isDev: boolean;
    notifyPosition: (ctx: MasonryLayoutContext, key: string, position: number) => void;
    setTotalSize: (ctx: MasonryLayoutContext, totalSize: number) => void;
};

// Items in a column touch, so an item's bottom is the next item's top in its column,
// or the column height for the last one. Every item below placedCount is in columnItems.
type MasonryLayout = {
    columnHeights: number[];
    columnItems: number[][];
    // Items below knownCount have known sizes, so their positions hold until a size or data change below it.
    knownCount: number;
    numColumns: number;
    placedCount: number;
    resolvedItems: Map<string, unknown>;
};

const layouts = new WeakMap<MasonryLayoutState, MasonryLayout>();

function getNumColumns(ctx: MasonryLayoutContext) {
    const numColumnsValue = ctx.values.get("numColumns");
    return typeof numColumnsValue === "number" && Number.isFinite(numColumnsValue)
        ? Math.max(1, Math.floor(numColumnsValue))
        : 1;
}

function resetLayout(layout: MasonryLayout, numColumns: number) {
    layout.columnHeights = Array<number>(numColumns).fill(0);
    layout.columnItems = Array.from({ length: numColumns }, () => []);
    layout.knownCount = 0;
    layout.numColumns = numColumns;
    layout.placedCount = 0;
}

function getLayout(state: MasonryLayoutState, numColumns: number) {
    let layout = layouts.get(state);
    if (!layout) {
        layout = {
            columnHeights: [],
            columnItems: [],
            knownCount: 0,
            numColumns,
            placedCount: 0,
            resolvedItems: new Map(),
        };
        resetLayout(layout, numColumns);
        layouts.set(state, layout);
    }
    return layout;
}

function getItemBottom(layout: MasonryLayout, positions: number[], column: number, itemIndexInColumn: number) {
    const items = layout.columnItems[column];
    return itemIndexInColumn + 1 < items.length
        ? positions[items[itemIndexInColumn + 1]]
        : layout.columnHeights[column];
}

// Returns the first slot in the column whose item ends below scrollTop.
function findFirstBelow(layout: MasonryLayout, positions: number[], column: number, scrollTop: number) {
    let low = 0;
    let high = layout.columnItems[column].length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (getItemBottom(layout, positions, column, mid) > scrollTop) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
}

// Returns the first slot in the column whose item starts below scrollBottom.
function findFirstStartingBelow(layout: MasonryLayout, positions: number[], column: number, scrollBottom: number) {
    const items = layout.columnItems[column];
    let low = 0;
    let high = items.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (positions[items[mid]] > scrollBottom) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
}

// The core stores a size under the item's key and never asks for a fixed one again, so a
// new item object under the same key must be re-asked or it keeps its old height. That
// includes a key that so far has only an estimate, which the core prefers to asking.
function refreshFixedSize(ctx: MasonryLayoutContext, key: string, index: number, item: unknown) {
    const {
        props: { getFixedItemSize, getItemType },
        sizes,
        sizesKnown,
    } = ctx.state;
    if (getFixedItemSize) {
        const fixedSize = getFixedItemSize(item, index, getItemType ? (getItemType(item, index) ?? "") : "");
        if (fixedSize !== undefined && fixedSize + ctx.scrollAxisGap !== sizesKnown.get(key)) {
            sizesKnown.set(key, fixedSize + ctx.scrollAxisGap);
            sizes.set(key, fixedSize + ctx.scrollAxisGap);
        }
    }
}

function updateMasonryItemPositions(
    ctx: MasonryLayoutContext,
    dataChanged: boolean | undefined,
    options: {
        doMVCP?: boolean;
        forceFullUpdate?: boolean;
        optimizeForVisibleWindow?: boolean;
        scrollBottomBuffered: number;
        scrollVelocity?: number;
        startIndex: number;
    },
    dependencies: MasonryLayoutDependencies,
) {
    const state = ctx.state;
    const {
        columns,
        columnSpans,
        idCache,
        indexByKey,
        positions,
        props: { data, getFixedItemSize },
        sizesKnown,
    } = state;
    const dataLength = data.length;
    const numColumns = getNumColumns(ctx);
    const layout = getLayout(state, numColumns);
    const pendingScrollAdjust = ctx.values.get("scrollAdjustPending");
    const useAverageSize = true;
    const preferCachedSize =
        !options.doMVCP ||
        dataChanged ||
        state.scrollAdjustHandler.getAdjust() !== 0 ||
        (typeof pendingScrollAdjust === "number" ? pendingScrollAdjust : 0) !== 0;
    const notifyTotalSizeWhileCachingSizes = false;
    const needsIndexByKey = dataChanged || indexByKey.size === 0;

    if (
        needsIndexByKey ||
        options.forceFullUpdate ||
        layout.numColumns !== numColumns ||
        positions.length < layout.knownCount
    ) {
        resetLayout(layout, numColumns);
    }

    if (dataLength === 0) {
        columns.length = 0;
        columnSpans.length = 0;
        positions.length = 0;
        layout.resolvedItems.clear();
        dependencies.setTotalSize(ctx, 0);
        return;
    }

    if (state.minIndexSizeChanged !== undefined) {
        layout.knownCount = Math.min(layout.knownCount, state.minIndexSizeChanged);
    }
    const startIndex = Math.min(layout.placedCount, Math.max(0, options.startIndex, layout.knownCount));
    if (startIndex >= dataLength) {
        return;
    }

    const { columnHeights, columnItems } = layout;
    const getSize = (key: string, itemIndex: number) =>
        sizesKnown.get(key) ??
        dependencies.getItemSize(
            ctx,
            key,
            itemIndex,
            data[itemIndex],
            useAverageSize,
            preferCachedSize,
            notifyTotalSizeWhileCachingSizes,
        );

    for (let column = 0; column < numColumns; column++) {
        const items = columnItems[column];
        while (items.length > 0 && items[items.length - 1] >= startIndex) {
            items.pop();
        }
        const lastIndex = items[items.length - 1];
        columnHeights[column] =
            lastIndex === undefined
                ? 0
                : positions[lastIndex] + getSize(idCache[lastIndex] ?? dependencies.getId(state, lastIndex), lastIndex);
    }

    const previousResolvedItems = dataChanged && getFixedItemSize ? layout.resolvedItems : undefined;
    const resolvedItems = previousResolvedItems ? new Map<string, unknown>() : undefined;
    const hasPositionListeners = ctx.positionListeners.size > 0;
    const indexByKeyForChecking = dependencies.isDev && needsIndexByKey ? new Map<string, number>() : undefined;
    const velocity = options.scrollVelocity ?? dependencies.getScrollVelocity(state);
    const shouldOptimize =
        !options.forceFullUpdate && !dataChanged && (options.optimizeForVisibleWindow || Math.abs(velocity) > 0);
    const maxVisibleArea = options.scrollBottomBuffered + 1000;
    let breakAt: number | undefined;
    let index = startIndex;

    for (; index < dataLength; index++) {
        if (shouldOptimize && breakAt !== undefined && index > breakAt) {
            break;
        }

        let columnIndex = 0;
        let position = columnHeights[0];
        for (let candidate = 1; candidate < numColumns; candidate++) {
            if (columnHeights[candidate] < position) {
                columnIndex = candidate;
                position = columnHeights[candidate];
            }
        }

        if (
            shouldOptimize &&
            breakAt === undefined &&
            !state.scrollingTo &&
            !dataChanged &&
            position > maxVisibleArea
        ) {
            breakAt = index + numColumns + 10;
        }

        const key = idCache[index] ?? dependencies.getId(state, index);
        if (resolvedItems) {
            const item = data[index];
            if (previousResolvedItems!.get(key) !== item) {
                refreshFixedSize(ctx, key, index, item);
            }
            resolvedItems.set(key, item);
        }
        const size = getSize(key, index);
        if (index === layout.knownCount && sizesKnown.has(key)) {
            layout.knownCount = index + 1;
        }

        if (indexByKeyForChecking) {
            if (indexByKeyForChecking.has(key)) {
                console.error(
                    `[legend-list] Error: Detected overlapping key (${key}) which causes missing items and gaps and other terrrible things. Check that keyExtractor returns unique values.`,
                );
            }
            indexByKeyForChecking.set(key, index);
        }

        if (positions[index] !== position) {
            positions[index] = position;
            if (hasPositionListeners) {
                dependencies.notifyPosition(ctx, key, position);
            }
        }
        columns[index] = columnIndex + 1;
        columnSpans[index] = 1;
        columnItems[columnIndex].push(index);
        columnHeights[columnIndex] = position + size;

        if (needsIndexByKey) {
            indexByKey.set(key, index);
        }
    }

    layout.placedCount = index;
    if (resolvedItems) {
        layout.resolvedItems = resolvedItems;
    }

    if (index === dataLength) {
        dependencies.setTotalSize(ctx, Math.max(...columnHeights));
    }
}

// Masonry item bottoms are not ordered across columns, so the first item in range is
// the earliest of each column's first item that ends below scrollTop.
updateMasonryItemPositions.findStartIndex = (ctx: MasonryLayoutContext, _startIndex: number, scrollTop: number) => {
    const { positions } = ctx.state;
    const layout = getLayout(ctx.state, getNumColumns(ctx));
    let firstIndex = layout.placedCount;
    for (let column = 0; column < layout.numColumns; column++) {
        const slot = findFirstBelow(layout, positions, column, scrollTop);
        const index = layout.columnItems[column][slot];
        if (index !== undefined && index < firstIndex) {
            firstIndex = index;
        }
    }
    return Math.min(firstIndex, Math.max(0, ctx.state.props.data.length - 1));
};

// The range changes only when an edge crosses a column boundary: the top edge moving
// above the bottom of a column's last item before the range, or the bottom edge
// reaching the top of a column's first item after it.
updateMasonryItemPositions.getScrollWindow = (
    ctx: MasonryLayoutContext,
    scrollTopBuffered: number,
    scrollBottomBuffered: number,
) => {
    const { positions } = ctx.state;
    const layout = getLayout(ctx.state, getNumColumns(ctx));
    const isPlacementComplete = layout.placedCount >= ctx.state.props.data.length;
    let top: number | null = null;
    let bottom: number | null = null;
    for (let column = 0; column < layout.numColumns; column++) {
        const items = layout.columnItems[column];
        const firstInRange = findFirstBelow(layout, positions, column, scrollTopBuffered);
        if (firstInRange > 0) {
            const edge = getItemBottom(layout, positions, column, firstInRange - 1);
            top = top === null ? edge : Math.max(top, edge);
        }
        const firstAfterRange = findFirstStartingBelow(layout, positions, column, scrollBottomBuffered);
        const edge =
            firstAfterRange < items.length
                ? positions[items[firstAfterRange]]
                : isPlacementComplete
                  ? null
                  : layout.columnHeights[column];
        if (edge !== null) {
            bottom = bottom === null ? edge : Math.min(bottom, edge);
        }
    }
    return { bottom, top };
};

const MasonryLegendList = React.forwardRef(function MasonryLegendListComponent<ItemT>(
    { numColumns, ...rest }: MasonryLegendListProps<ItemT>,
    ref: React.ForwardedRef<LegendListRef>,
) {
    const resolvedNumColumns = Number.isFinite(numColumns) ? Math.max(1, Math.floor(numColumns)) : 1;

    return (
        <LegendList
            {...rest}
            {...({ layoutStrategyInternal: updateMasonryItemPositions } as any)}
            horizontal={false}
            numColumns={resolvedNumColumns}
            overrideItemLayout={undefined}
            ref={ref}
        />
    );
}) as MasonryLegendListComponentType;

export { MasonryLegendList };
export type { MasonryLegendListProps };
