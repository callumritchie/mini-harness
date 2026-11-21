import { Icon, toolIcon } from "./Icon";

export function ToolIcon({ name }: { name: string }) {
  return <Icon name={toolIcon(name)} className="tool-icon" />;
}
