// SPDX-License-Identifier: MIT
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ExportVideosModal from '../../cvat-ui/src/components/projects-page/export-videos-modal';
function App(): JSX.Element {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Export videos</button>
        <ExportVideosModal project={{ id: 3, name: 'Surgery' } as any} open={open} onClose={() => setOpen(false)} />
    </>;
}
createRoot(document.getElementById('root')!).render(<App />);
