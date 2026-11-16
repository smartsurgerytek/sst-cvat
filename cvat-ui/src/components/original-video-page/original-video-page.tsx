// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Spin from 'antd/lib/spin';
import { getCore } from 'cvat-core-wrapper';
import OriginalVideoList from './original-video-list';

// Use the real annotation workspace so video tasks inherit all native tools,
// label types, attributes, history, permissions, and annotation persistence.
export default function OriginalVideoPage(): JSX.Element {
    const { projectId, videoId } = useParams<{ projectId: string; videoId?: string }>();
    const history = useHistory();
    const [error, setError] = useState('');
    useEffect(() => {
        if (!videoId) return undefined;
        let disposed = false;
        const open = async (): Promise<void> => {
            try {
                const url = `${getCore().config.backendAPI}/projects/${projectId}/original-videos/${videoId}`;
                let { data } = await Axios.get(url);
                if (!data.job_id) ({ data } = await Axios.post(url));
                if (!disposed) {
                    history.replace(data.job_count > 1 ? `/tasks/${data.task_id}` :
                        `/tasks/${data.task_id}/jobs/${data.job_id}`);
                }
            } catch (reason) {
                if (!disposed) {
                    setError(Axios.isAxiosError(reason) ?
                        JSON.stringify(reason.response?.data || reason.message) : String(reason));
                }
            }
        };
        open();
        return () => { disposed = true; };
    }, [projectId, videoId]);
    return (
        <div style={{ width: '100%', padding: 24, overflow: 'auto' }}>
            <Link to={`/projects/${projectId}`}>Back to project</Link>
            {error && <Alert type='error' showIcon message='Could not open video task' description={error} />}
            {!error && videoId && <Spin tip='Opening video annotation workspace' />}
            {!error && !videoId && <OriginalVideoList projectId={+projectId} />}
        </div>
    );
}
