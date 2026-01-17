import React, { useState } from 'react';
import { importDictionaryWords } from '../services/dataService';

const DICTIONARIES = [
    { name: 'Primary School (小学)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/%E5%B0%8F%E5%AD%A6%E8%8B%B1%E8%AF%AD%E5%A4%A7%E7%BA%B2%E8%AF%8D%E6%B1%87.txt', tag: 'Primary' },
    { name: 'Junior High (初中)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/%E4%B8%AD%E8%80%83%E8%8B%B1%E8%AF%AD%E8%AF%8D%E6%B1%87%E8%A1%A8.txt', tag: 'Junior' },
    { name: 'Senior High (高中)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/Highschool_edited.txt', tag: 'Senior' },
    { name: 'CET-4 (四级)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET4_edited.txt', tag: 'CET-4' },
    { name: 'CET-6 (六级)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET6_edited.txt', tag: 'CET-6' },
];

export const DictionaryImporter: React.FC<{ userId: string, onImportComplete: () => void }> = ({ userId, onImportComplete }) => {
    const [status, setStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});

    const handleImport = async (dict: typeof DICTIONARIES[0]) => {
        setStatus(prev => ({ ...prev, [dict.tag]: 'loading' }));
        try {
            const response = await fetch(dict.url);
            if (!response.ok) throw new Error('Fetch failed');
            
            const text = await response.text();
            let wordList: string[] = [];

            if (dict.tag === 'Primary' || dict.tag === 'Senior') {
                // Formatting: Clean lines
                wordList = text.split('\n')
                               .map(l => l.trim())
                               .filter(l => l.length > 1 && !l.startsWith('#') && /^[a-zA-Z\s-]+$/.test(l));
            } else {
                // Formatting: Dictionary style "word [phonetic] ..."
                wordList = text.split('\n')
                    .map(line => {
                         // Match start of line alphabets (sometimes followed by space or [)
                        const match = line.match(/^([a-zA-Z]+)/);
                        return match ? match[1] : '';
                    })
                    .filter(w => w.length > 1);
            }

            // Limit to reasonable amount if file is huge (CET is usually 4-6k, fine)
            console.log(`Parsed ${wordList.length} words for ${dict.tag}`);

            if (wordList.length > 0) {
                 await importDictionaryWords(userId, wordList, dict.tag);
            }
            
            setStatus(prev => ({ ...prev, [dict.tag]: 'success' }));
            onImportComplete();
        } catch (e) {
            console.error(e);
            setStatus(prev => ({ ...prev, [dict.tag]: 'error' }));
        }
    };

    return (
        <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg mb-6">
            <h3 className="font-headline text-xl text-electric-blue mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined">cloud_download</span>
                IMPORT DICTIONARIES
            </h3>
            <p className="text-mid-grey text-sm mb-4">
                Click to download and verify word lists to your database.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {DICTIONARIES.map(d => (
                    <button 
                        key={d.tag}
                        onClick={() => handleImport(d)}
                        disabled={status[d.tag] === 'loading' || status[d.tag] === 'success'}
                        className={`p-3 rounded-lg border text-left transition-all ${
                            status[d.tag] === 'success' ? 'bg-green-900/30 border-green-500/50 text-green-400' :
                            status[d.tag] === 'loading' ? 'bg-mid-charcoal border-transparent animate-pulse text-white' :
                            'bg-dark-charcoal border-mid-charcoal hover:border-electric-blue text-white'
                        }`}
                    >
                        <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-sm">{d.name}</span>
                            {status[d.tag] === 'success' && <span className="material-symbols-outlined text-sm">check_circle</span>}
                            {status[d.tag] === 'loading' && <span className="material-symbols-outlined text-sm animate-spin">refresh</span>}
                            {status[d.tag] === 'error' && <span className="material-symbols-outlined text-sm text-red-500">error</span>}
                        </div>
                        <div className="text-[10px] text-mid-grey uppercase tracking-wider">
                            {status[d.tag] === 'success' ? 'INSTALLED' : 'AVAILABLE'}
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
};
