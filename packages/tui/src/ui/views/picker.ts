import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";

import type { DiscoveredInstance } from "../../data/instances.js";
import { selectListTheme, styles } from "../theme.js";

export interface PickerViewOptions {
  readonly onSelect: (instance: DiscoveredInstance) => void;
  readonly onRefresh: () => void;
}

/** Instance picker: every discoverable running agent, `enter` connects. */
export class PickerView extends Container {
  readonly list: SelectList;
  private instances: readonly DiscoveredInstance[] = [];
  private readonly header = new Text("", 1, 0);
  private readonly options: PickerViewOptions;

  constructor(options: PickerViewOptions) {
    super();
    this.options = options;
    this.list = new SelectList([], 12, selectListTheme);
    this.list.onSelect = (item: SelectItem) => {
      const instance = this.instances.find((candidate) => candidate.source.sourceId === item.value);
      if (instance !== undefined) {
        this.options.onSelect(instance);
      }
    };
    this.addChild(this.header);
    this.addChild(this.list);
    this.addChild(new Text(styles.dim("enter connect · r refresh · tab chat"), 1, 0));
    this.setInstances([], "");
  }

  handleInput(data: string): void {
    if (data === "r" || data === "R") {
      this.options.onRefresh();
      return;
    }
    this.list.handleInput(data);
  }

  setInstances(instances: readonly DiscoveredInstance[], registryDir: string): void {
    this.instances = instances;
    if (instances.length === 0) {
      this.header.setText(
        `${styles.bold("No running agents found.")}\n${styles.muted(
          `Registry: ${registryDir}\nStart one with \`mono-agent start\` in its folder, then press r.`,
        )}`,
      );
    } else {
      this.header.setText(styles.bold(`Running agents (${instances.length})`));
    }
    const items = instances.map((instance): SelectItem => {
      const source = instance.source;
      const health = source.health === "running" ? styles.success("●") : styles.warning("◐");
      const transports = (source.transports ?? []).join(", ");
      const chat = instance.tuiBaseUrl === undefined ? " — no tui endpoint (chat disabled)" : "";
      return {
        value: source.sourceId,
        label: `${health} ${source.label}`,
        description: `pid ${source.pid ?? "?"} · ${transports}${chat}`,
      };
    });
    // SelectList has no public setItems in 0.79; rebuild via filter reset.
    (this.list as unknown as { items: SelectItem[]; filteredItems: SelectItem[] }).items = items;
    this.list.setFilter("");
    this.list.setSelectedIndex(0);
    this.list.invalidate();
  }
}
