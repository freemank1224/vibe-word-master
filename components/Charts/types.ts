/**
 * Chart component types
 * 图表组件类型定义
 */

export interface PieChartData {
  label: string;
  value: number;
  color: string;
  icon?: string;
}

export interface PieChartProps {
  data: PieChartData[];
  size?: number;
  strokeWidth?: number;
  showLabels?: boolean;
  centerContent?: React.ReactNode;
  className?: string;
}
