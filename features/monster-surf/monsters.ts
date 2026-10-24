import type { MonsterStyle } from './types';

/** The site's seven original illustrations, cropped at their alpha bounds without changing the files. */
export const SURF_MONSTERS: MonsterStyle[] = [
  { id: 0, label: 'SUN', nameZh: '星期日', nameEn: 'Sunday', color: '#B99ADE', image: '/monsterImages/M0.webp', crop: { x: 84, y: 187, width: 865, height: 684 } },
  { id: 1, label: 'MON', nameZh: '星期一', nameEn: 'Monday', color: '#69CAE6', image: '/monsterImages/M1.webp', crop: { x: 155, y: 70, width: 717, height: 871 } },
  { id: 2, label: 'TUE', nameZh: '星期二', nameEn: 'Tuesday', color: '#82D6B5', image: '/monsterImages/M2.webp', crop: { x: 152, y: 95, width: 712, height: 821 } },
  { id: 3, label: 'WED', nameZh: '星期三', nameEn: 'Wednesday', color: '#BFA1EA', image: '/monsterImages/M3.webp', crop: { x: 152, y: 107, width: 724, height: 821 } },
  { id: 4, label: 'THU', nameZh: '星期四', nameEn: 'Thursday', color: '#FFBD7C', image: '/monsterImages/M4.webp', crop: { x: 162, y: 115, width: 675, height: 768 } },
  { id: 5, label: 'FRI', nameZh: '星期五', nameEn: 'Friday', color: '#FF9887', image: '/monsterImages/M5.webp', crop: { x: 82, y: 124, width: 808, height: 811 } },
  { id: 6, label: 'SAT', nameZh: '星期六', nameEn: 'Saturday', color: '#F5DC72', image: '/monsterImages/M6.webp', crop: { x: 184, y: 91, width: 646, height: 806 } },
];
