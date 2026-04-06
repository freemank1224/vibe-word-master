import React, { useMemo } from 'react';
import { PieChartProps } from './types';
import { HoverTranslationText } from '../HoverTranslationText';

export const PieChart: React.FC<PieChartProps> = ({
  data,
  size = 160,
  strokeWidth = 20,
  showLabels = true,
  centerContent,
  className = ''
}) => {
  const total = useMemo(() => {
    return data.reduce((sum, item) => sum + item.value, 0);
  }, [data]);

  const { paths, circumference } = useMemo(() => {
    const radius = (size - strokeWidth) / 2;
    const circ = 2 * Math.PI * radius;
    let currentAngle = 0;

    const svgPaths = data.map((item, index) => {
      if (item.value === 0) return null;

      const percentage = item.value / total;
      const angle = percentage * 360;
      const dashArray = (percentage * circ).toFixed(2);
      const gapAngle = currentAngle * (Math.PI / 180);
      const rotateAngle = currentAngle - 90; // Start from top

      currentAngle += angle;

      return (
        <circle
          key={index}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={item.color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${dashArray} ${circ}`}
          strokeDashoffset="0"
          transform={`rotate(${rotateAngle} ${size / 2} ${size / 2})`}
          className="transition-all duration-500 ease-out"
          style={{
            opacity: 0.9,
            filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.3))'
          }}
        />
      );
    });

    return {
      paths: svgPaths,
      circumference: circ
    };
  }, [data, total, size, strokeWidth]);

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          {paths}
        </svg>
        {centerContent && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              width: size - strokeWidth * 2,
              height: size - strokeWidth * 2,
              margin: strokeWidth
            }}
          >
            {centerContent}
          </div>
        )}
      </div>

      {showLabels && (
        <div className={`mt-4 grid gap-3 w-full px-2 ${data.length <= 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
          {data.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: item.color,
                  boxShadow: `0 0 8px ${item.color}80`
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-text-dark font-mono uppercase tracking-wider truncate">
                  {item.label}
                </div>
                <div className="text-sm font-bold text-white">
                  {total > 0 ? Math.round((item.value / total) * 100) : 0}%
                  <span className="text-xs text-text-light ml-1">
                    ({item.value})
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface ProgressPieChartProps {
  words: any[];
  className?: string;
}

export const ProgressPieChart: React.FC<ProgressPieChartProps> = ({ words, className = '' }) => {
  const chartData = useMemo(() => {
    const total = words.length;
    const tested = words.filter(w => w.tested).length;
    const untested = total - tested;

    return [
      {
        label: 'Tested',
        value: tested,
        color: '#3B82F6' // electric-blue
      },
      {
        label: 'Untested',
        value: untested,
        color: '#404040' // mid-charcoal
      }
    ];
  }, [words]);

  const totalWords = chartData.reduce((sum, item) => sum + item.value, 0);
  const testedWords = chartData[0].value;

  return (
    <PieChart
      data={chartData}
      size={160}
      strokeWidth={24}
      centerContent={
        <div className="text-center">
          <div className="text-2xl font-bold text-white">
            {totalWords > 0 ? Math.round((testedWords / totalWords) * 100) : 0}%
          </div>
          <div className="text-[9px] text-text-dark font-mono uppercase tracking-wider">
            Coverage
          </div>
        </div>
      }
      className={className}
    />
  );
};

export const MasteryPieChart: React.FC<ProgressPieChartProps> = ({ words, className = '' }) => {
  const chartData = useMemo(() => {
    const tested = words.filter(w => w.tested);

    // 三级分类基于 error_count
    // - Mastered: error_count === 0 (无错误记录)
    // - Learning: 0 < error_count <= 2 (少量错误)
    // - Difficult: error_count > 2 (多次错误)
    const mastered = tested.filter(w => w.error_count === 0).length;
    const learning = tested.filter(w => w.error_count > 0 && w.error_count <= 2).length;
    const difficult = tested.filter(w => w.error_count > 2).length;

    return [
      {
        label: 'Mastered',
        value: mastered,
        color: '#10B981' // electric-green - 已完全掌握
      },
      {
        label: 'Learning',
        value: learning,
        color: '#F59E0B' // orange - 学习中
      },
      {
        label: 'Difficult',
        value: difficult,
        color: '#EF4444' // red - 困难词
      }
    ];
  }, [words]);

  const totalTested = chartData.reduce((sum, item) => sum + item.value, 0);
  const masteredWords = chartData[0].value;

  return (
    <div className={className}>
      <PieChart
        data={chartData}
        size={160}
        strokeWidth={24}
        centerContent={
          <div className="text-center">
            <div className="text-2xl font-bold text-white">
              {totalTested > 0 ? Math.round((masteredWords / totalTested) * 100) : 0}%
            </div>
            <div className="text-[9px] text-text-dark font-mono uppercase tracking-wider">
              <HoverTranslationText text="Mastery" translation="掌握度" />
            </div>
          </div>
        }
      />
      {/* 分类说明 */}
      <div className="mt-4 pt-4 border-t border-mid-charcoal/30">
        <div className="text-[9px] text-text-dark font-mono uppercase tracking-wider mb-2 text-center">
          <HoverTranslationText text="Classification" translation="分类说明" />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[9px]">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <div className="w-2 h-2 rounded-full bg-electric-green" />
              <span className="font-bold text-white"><HoverTranslationText text="Mastered" translation="已掌握" /></span>
            </div>
            <div className="text-text-light"><HoverTranslationText text="0 errors" translation="0 个错误" /></div>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <div className="w-2 h-2 rounded-full bg-orange-400" />
              <span className="font-bold text-white"><HoverTranslationText text="Learning" translation="学习中" /></span>
            </div>
            <div className="text-text-light"><HoverTranslationText text="1-2 errors" translation="1-2 个错误" /></div>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="font-bold text-white"><HoverTranslationText text="Difficult" translation="困难" /></span>
            </div>
            <div className="text-text-light"><HoverTranslationText text="3+ errors" translation="3 个及以上错误" /></div>
          </div>
        </div>
      </div>
    </div>
  );
};
