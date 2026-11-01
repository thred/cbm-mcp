export type C64LabelSource = "user" | "vice";
export type C64LabelKind = "address" | "code";

interface C64LabelBase {
    readonly id: string;
    readonly viewId: string;
    readonly address: number;
    readonly name: string;
    readonly source: C64LabelSource;
}

export type C64AnalysisLabel =
    | (C64LabelBase & { readonly kind: "address" })
    | (C64LabelBase & {
          readonly kind: "code";
          readonly snapshotId: string;
          readonly instructions: readonly (readonly number[])[];
      });

export interface C64LabelMatch {
    readonly label: C64AnalysisLabel;
    readonly status: "fixed" | "unchanged" | "modified" | "relocated" | "orphaned" | "other-view";
    readonly address?: number;
    readonly opcodeSimilarity?: number;
    readonly byteSimilarity?: number;
}

export interface C64ViceLabelInput {
    readonly address: number;
    readonly name: string;
    readonly kind?: C64LabelKind;
}

export interface C64ViceLabelImportResult {
    readonly imported: number;
    readonly removed: number;
    readonly conflicts: readonly {
        readonly name: string;
        readonly viceAddress: number;
        readonly userAddress: number;
    }[];
}

const graphLabels = new WeakMap<object, readonly C64LabelMatch[]>();

export function setGraphLabels(graph: object, matches: readonly C64LabelMatch[]): void {
    graphLabels.set(graph, structuredClone(matches));
}

export function getGraphLabels(graph: object): readonly C64LabelMatch[] {
    return structuredClone(graphLabels.get(graph) ?? []);
}
