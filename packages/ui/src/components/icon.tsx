import { onMount, splitProps, type ComponentProps } from "solid-js"

const icons = {
  "align-right": `<path d="M17 12H3"/><path d="m11 18 6-6-6-6"/><path d="M21 5v14"/>`,
  "arrow-up": `<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`,
  "arrow-left": `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
  "arrow-right": `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
  archive: `<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>`,
  "bubble-5": `<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>`,
  prompt: `<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>`,
  brain: `<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 01-3-4 4.17 4.17 0 01-3 4"/><path d="M17.707 6.294A3 3 0 1012 5a3 3 0 10-5.707 1.294"/><path d="M17.996 5.125a4 4 0 012.526 5.77"/><path d="M18 18a4 4 0 002-7.465"/><path d="M19.967 17.482a4 4 0 11-7.967.517 4 4 0 11-7.967-.517"/><path d="M6 18a4 4 0 01-2-7.465"/><path d="M6.004 5.125a4 4 0 00-2.526 5.77"/>`,
  fork: `<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>`,
  "bullet-list": `<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>`,
  "check-small": `<path d="M20 6 9 17l-5-5"/>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "chevron-left": `<path d="m15 18-6-6 6-6"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
  "chevron-grabber-vertical": `<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`,
  "chevron-double-right": `<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>`,
  "circle-x": `<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`,
  close: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  "close-small": `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  checklist: `<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>`,
  console: `<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>`,
  review: `<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>`,
  "review-active": `<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" fill="currentColor" fill-opacity="0.1"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>`,
  expand: `<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>`,
  collapse: `<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>`,
  code: `<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>`,
  "code-lines": `<path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"/>`,
  "circle-ban-sign": `<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>`,
  "edit-small-2": `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>`,
  eye: `<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`,
  enter: `<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>`,
  folder: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  "file-tree": `<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>`,
  "file-tree-active": `<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" fill="currentColor" fill-opacity="0.1"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" fill="currentColor" fill-opacity="0.1"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>`,
  "magnifying-glass": `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
  "plus-small": `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  "new-session": `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>`,
  "new-session-active": `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" fill="currentColor" fill-opacity="0.1"/>`,
  "pencil-line": `<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>`,
  // The three brand marks (mcp, github, discord) are logos, not Lucide icons: their own drawing is scaled onto the
  // 24 grid (the stroke of mcp is divided by the scale so that it still renders at 2).
  mcp: `<g transform="scale(1.2)" stroke-width="1.6667"><path d="M0.972656 9.37176L9.5214 1.60019C10.7018 0.527151 12.6155 0.527151 13.7957 1.60019C14.9761 2.67321 14.9761 4.41295 13.7957 5.48599L7.3397 11.3552"/><path d="M7.42871 11.2747L13.7957 5.48643C14.9761 4.41338 16.8898 4.41338 18.0702 5.48643L18.1147 5.52688C19.2951 6.59993 19.2951 8.33966 18.1147 9.4127L10.3831 16.4414C9.98966 16.7991 9.98966 17.379 10.3831 17.7366L11.9707 19.1799"/><path d="M11.6587 3.54346L5.33619 9.29119C4.15584 10.3642 4.15584 12.1039 5.33619 13.177C6.51649 14.25 8.43019 14.25 9.61054 13.177L15.9331 7.42923"/></g>`,
  glasses: `<circle cx="6" cy="15" r="4"/><circle cx="18" cy="15" r="4"/><path d="M14 15a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M2.5 13 5 7c.7-1.3 1.4-2 3-2"/><path d="M21.5 13 19 7c-.7-1.3-1.5-2-3-2"/>`,
  "magnifying-glass-menu": `<path d="M21 5H3"/><path d="M10 12H3"/><path d="M10 19H3"/><circle cx="17" cy="15" r="3"/><path d="m21 19-1.9-1.9"/>`,
  "window-cursor": `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  task: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  subagent: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>`,
  status: `<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  "status-active": `<rect width="20" height="8" x="2" y="2" rx="2" ry="2" fill="currentColor" fill-opacity="0.1"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2" fill="currentColor" fill-opacity="0.1"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  sidebar: `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  "sidebar-active": `<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z" fill="currentColor" fill-opacity="0.1" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  "layout-left": `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  "layout-left-partial": `<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z" fill="currentColor" fill-opacity="0.16" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  "layout-left-full": `<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z" fill="currentColor" fill-opacity="1" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  "layout-right": `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>`,
  "layout-right-partial": `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z" fill="currentColor" fill-opacity="0.16" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>`,
  "layout-right-full": `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z" fill="currentColor" fill-opacity="1" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>`,
  "square-arrow-top-right": `<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>`,
  "open-file": `<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>`,
  "speech-bubble": `<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>`,
  comment: `<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>`,
  "folder-add-left": `<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  github: `<g transform="scale(1.2)" fill="currentColor" stroke="none"><path d="M10.0001 1.62549C14.6042 1.62549 18.3334 5.35465 18.3334 9.95882C18.333 11.7049 17.785 13.4068 16.7666 14.8251C15.7482 16.2434 14.3107 17.3066 12.6563 17.8651C12.2397 17.9484 12.0834 17.688 12.0834 17.4692C12.0834 17.188 12.0938 16.2922 12.0938 15.1776C12.0938 14.3963 11.8334 13.8963 11.5313 13.6359C13.3855 13.4276 15.3334 12.7192 15.3334 9.52132C15.3334 8.60465 15.0105 7.86507 14.4792 7.28174C14.5626 7.0734 14.8542 6.21924 14.3959 5.0734C14.3959 5.0734 13.698 4.84424 12.1042 5.92757C11.4376 5.74007 10.7292 5.64632 10.0209 5.64632C9.31258 5.64632 8.60425 5.74007 7.93758 5.92757C6.34383 4.85465 5.64592 5.0734 5.64592 5.0734C5.18758 6.21924 5.47925 7.0734 5.56258 7.28174C5.03133 7.86507 4.70842 8.61507 4.70842 9.52132C4.70842 12.7088 6.64592 13.4276 8.50008 13.6359C8.2605 13.8442 8.04175 14.2088 7.96883 14.7505C7.48967 14.9692 6.29175 15.3234 5.54175 14.063C5.3855 13.813 4.91675 13.1984 4.2605 13.2088C3.56258 13.2192 3.97925 13.6047 4.27092 13.7609C4.62508 13.9588 5.03133 14.6984 5.12508 14.938C5.29175 15.4067 5.83342 16.3026 7.92717 15.9172C7.92717 16.6151 7.93758 17.2713 7.93758 17.4692C7.93758 17.688 7.78133 17.938 7.36467 17.8651C5.70491 17.3126 4.26126 16.2515 3.23851 14.8324C2.21576 13.4133 1.66583 11.7081 1.66675 9.95882C1.66675 5.35465 5.39592 1.62549 10.0001 1.62549Z"/></g>`,
  discord: `<g transform="scale(1.2)" fill="currentColor" stroke="none"><path d="M16.0742 4.45014C14.9244 3.92097 13.7106 3.54556 12.4638 3.3335C12.2932 3.64011 12.1388 3.95557 12.0013 4.27856C10.6732 4.07738 9.32261 4.07738 7.99451 4.27856C7.85694 3.9556 7.70257 3.64014 7.53203 3.3335C6.28441 3.54735 5.06981 3.92365 3.91889 4.45291C1.63401 7.85128 1.01462 11.1652 1.32431 14.4322C2.6624 15.426 4.16009 16.1819 5.7523 16.6668C6.11082 16.1821 6.42806 15.6678 6.70066 15.1295C6.18289 14.9351 5.68315 14.6953 5.20723 14.4128C5.33249 14.3215 5.45499 14.2274 5.57336 14.136C6.95819 14.7907 8.46965 15.1302 9.99997 15.1302C11.5303 15.1302 13.0418 14.7907 14.4266 14.136C14.5463 14.2343 14.6688 14.3284 14.7927 14.4128C14.3159 14.6957 13.8152 14.9361 13.2965 15.1309C13.5688 15.669 13.8861 16.1828 14.2449 16.6668C15.8385 16.1838 17.3373 15.4283 18.6756 14.4335C19.039 10.645 18.0549 7.36145 16.0742 4.45014ZM7.09294 12.423C6.22992 12.423 5.51693 11.6357 5.51693 10.6671C5.51693 9.69852 6.20514 8.90427 7.09019 8.90427C7.97524 8.90427 8.68272 9.69852 8.66758 10.6671C8.65244 11.6357 7.97248 12.423 7.09294 12.423ZM12.907 12.423C12.0426 12.423 11.3324 11.6357 11.3324 10.6671C11.3324 9.69852 12.0206 8.90427 12.907 8.90427C13.7934 8.90427 14.4954 9.69852 14.4803 10.6671C14.4651 11.6357 13.7865 12.423 12.907 12.423Z"/></g>`,
  "layout-bottom": `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>`,
  "layout-bottom-partial": `<path d="M3 15h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" fill-opacity="0.16" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>`,
  "layout-bottom-full": `<path d="M3 15h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" fill-opacity="1" stroke="none"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>`,
  "dot-grid": `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
  "circle-check": `<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>`,
  copy: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  photo: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
  share: `<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>`,
  shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
  download: `<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>`,
  menu: `<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>`,
  server: `<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  branch: `<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>`,
  edit: `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>`,
  help: `<circle cx="12" cy="12" r="10"/><path d="M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5"/><path d="M12 17h.01"/>`,
  "settings-gear": `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`,
  dash: `<path d="M5 12h14"/>`,
  "cloud-upload": `<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>`,
  trash: `<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  sliders: `<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>`,
  keyboard: `<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>`,
  selector: `<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`,
  "arrow-down-to-line": `<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>`,
  warning: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  reset: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>`,
  link: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  providers: `<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>`,
  models: `<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>`,
  "arrow-undo-down": `<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>`,
}

// Every drawing is on the 24 grid (Lucide, ISC licence). The shared stroke attributes are set once on the
// <svg>, so a drawing only contains its shapes; a shape that must be filled says so itself.
const viewBox = "0 0 24 24"
const spriteID = "opencode-icon-sprite"
const symbol = (name: keyof typeof icons) => `opencode-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }
  const body = document.body as HTMLElement | null
  if (!body) return

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(([name, path]) => {
      return `<symbol id="${symbol(name as keyof typeof icons)}" viewBox="${viewBox}">${path}</symbol>`
    })
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  onMount(ensureSprite)

  return (
    <div
      data-component="icon"
      data-size={local.size || "normal"}
      data-directional={
        local.name === "arrow-left" ||
        local.name === "arrow-right" ||
        local.name === "chevron-left" ||
        local.name === "chevron-right"
          ? true
          : undefined
      }
    >
      <svg
        data-slot="icon-svg"
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        viewBox={viewBox}
        aria-hidden="true"
        {...others}
      >
        <use href={`#${symbol(local.name)}`} />
      </svg>
    </div>
  )
}
