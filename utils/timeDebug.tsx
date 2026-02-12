/**
 * Time Debug Component
 *
 * Displays current time in multiple timezones to verify
 * that frontend and database are using Beijing Time consistently.
 */

import React, { useState, useEffect } from 'react';
import { getBeijingDate, getBeijingTime, formatBeijingDate } from './beijingTime';

export const TimeDebug: React.FC = () => {
    const [times, setTimes] = useState({
        local: '',
        beijing: '',
        utc: ''
    });

    useEffect(() => {
        const updateTimes = () => {
            const now = new Date();

            // Local time (user's browser)
            const local = now.toLocaleString('zh-CN', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

            // Beijing Time (UTC+8)
            const beijing = getBeijingTime().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

            // UTC Time
            const utc = now.toUTCString();

            setTimes({ local, beijing, utc });
        };

        updateTimes();
        const interval = setInterval(updateTimes, 1000);

        return () => clearInterval(interval);
    }, []);

    return (
        <div className="fixed bottom-4 right-4 bg-dark-charcoal border border-mid-charcoal rounded-lg p-4 text-xs font-mono z-[100] opacity-80 hover:opacity-100 transition-opacity">
            <div className="font-bold text-electric-blue mb-2">⏰ TIME DEBUG</div>
            <div className="space-y-1">
                <div>
                    <span className="text-text-dark">本地时间:</span>
                    <span className="text-text-light ml-2">{times.local}</span>
                </div>
                <div>
                    <span className="text-electric-green">北京时间:</span>
                    <span className="text-white ml-2">{times.beijing}</span>
                </div>
                <div>
                    <span className="text-text-dark">UTC时间:</span>
                    <span className="text-text-light ml-2">{times.utc}</span>
                </div>
                <div className="pt-2 border-t border-mid-charcoal/30 mt-2">
                    <span className="text-blue-400">今日(北京):</span>
                    <span className="text-blue-400 ml-2">{getBeijingDate()}</span>
                </div>
            </div>
        </div>
    );
};
