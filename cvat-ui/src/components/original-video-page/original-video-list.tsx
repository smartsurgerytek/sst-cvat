// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import { Link, useHistory } from 'react-router-dom';
import dayjs from 'dayjs';
import { Row, Col } from 'antd/lib/grid';
import Dropdown from 'antd/lib/dropdown';
import { MoreOutlined } from '@ant-design/icons';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Input from 'antd/lib/input';
import List from 'antd/lib/list';
import Space from 'antd/lib/space';
import Tag from 'antd/lib/tag';
import Typography from 'antd/lib/typography';
import { getCore } from 'cvat-core-wrapper';
import '../tasks-page/styles.scss';
import './styles.scss';

interface VideoItem {
    id: string;
    project_id: number;
    project_name: string;
    name: string;
    filename: string;
    duration: number;
    width: number;
    height: number;
    created_date: string;
    updated_date: string;
}

interface Props {
    projectId?: number;
}

export default function OriginalVideoList({ projectId }: Props): JSX.Element {
    const history = useHistory();
    const [items, setItems] = useState<VideoItem[]>([]);
    const [count, setCount] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const endpoint = `${getCore().config.backendAPI}/projects/${projectId ? `${projectId}/` : ''}original-videos`;

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        setError('');
        Axios.get(endpoint, { params: { page, page_size: 5, video_search: search } }).then((response) => {
            if (disposed) return;
            setItems(response.data.results);
            setCount(response.data.count);
        }).catch((reason) => {
            if (!disposed) {
                setError(Axios.isAxiosError(reason) ?
                    JSON.stringify(reason.response?.data || reason.message) : String(reason));
            }
        }).finally(() => {
            if (!disposed) setLoading(false);
        });
        return () => { disposed = true; };
    }, [endpoint, page, search, refresh]);

    return (
        <section
            className='cvat-original-video-list'
            aria-label='Video tasks'
            style={{
                margin: '12px 8px',
            }}
        >
            <Space wrap style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                    Video tasks
                    {' '}
                    <Tag>{count}</Tag>
                </Typography.Title>
                <Space wrap>
                    <Input.Search
                        aria-label='Search original videos'
                        placeholder='Search videos or projects'
                        allowClear
                        onSearch={(value) => { setSearch(value); setPage(1); }}
                    />
                    <Button onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
                </Space>
            </Space>
            {error && <Alert type='error' showIcon message='Could not load original videos' description={error} />}
            <List
                loading={loading}
                dataSource={items}
                pagination={count > 5 ? {
                    current: page, total: count, pageSize: 5, showSizeChanger: false, onChange: setPage,
                } : false}
                locale={{ emptyText: search ? 'No videos match this search.' : 'No video tasks yet.' }}
                renderItem={(item) => (
                    <List.Item style={{ display: 'block', padding: 0, border: 0 }}>
                        <Row
                            className='cvat-tasks-list-item'
                            justify='center'
                            align='top'
                            role='article'
                            aria-label={`Video task: ${item.name}`}
                        >
                            <Col span={4}>
                                <Link
                                    className='cvat-task-item-preview-wrapper'
                                    to={`/projects/${item.project_id}/videos/${item.id}`}
                                    aria-label={`Preview ${item.name}`}
                                >
                                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                                    <video
                                        className='cvat-task-item-preview'
                                        preload='metadata'
                                        muted
                                        src={[getCore().config.backendAPI, `projects/${item.project_id}`,
                                            `original-videos/${item.id}/media#t=0.1`].join('/')}
                                    />
                                </Link>
                            </Col>
                            <Col span={10} className='cvat-task-item-description'>
                                <Typography.Text ellipsis={{ tooltip: item.name }}>
                                    <Typography.Text strong type='secondary' className='cvat-item-task-id'>
                                        {`#${item.id.slice(0, 8)}: `}
                                    </Typography.Text>
                                    <Typography.Text strong className='cvat-item-task-name'>
                                        {item.name}
                                    </Typography.Text>
                                </Typography.Text>
                                <br />
                                <Typography.Text type='secondary'>
                                    {`Created on ${dayjs(item.created_date).format('MMMM Do YYYY')}`}
                                </Typography.Text>
                                <br />
                                <Typography.Text type='secondary'>
                                    {`Last updated ${dayjs(item.updated_date).fromNow()}`}
                                </Typography.Text>
                            </Col>
                            <Col span={7}>
                                <Row>
                                    <Col span={24} className='cvat-task-item-progress-wrapper'>
                                        <div>
                                            <Typography.Text strong type='secondary'>
                                                {`• Original MP4 · ${item.duration.toFixed(2)} s`}
                                            </Typography.Text>
                                        </div>
                                    </Col>
                                </Row>
                                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                                    {`${item.width} × ${item.height}`}
                                </Typography.Text>
                            </Col>
                            <Col span={3}>
                                <Row justify='end'>
                                    <Col>
                                        <Button
                                            className='cvat-item-open-task-button'
                                            type='primary'
                                            size='large'
                                            ghost
                                            href={`/projects/${item.project_id}/videos/${item.id}`}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                history.push(`/projects/${item.project_id}/videos/${item.id}`);
                                            }}
                                        >
                                            Open
                                        </Button>
                                    </Col>
                                </Row>
                                <Row justify='end'>
                                    <Col className='cvat-item-open-task-actions'>
                                        <Dropdown
                                            trigger={['click']}
                                            menu={{
                                                items: [
                                                    { key: 'open', label: 'Open video task', onClick: () => history.push(`/projects/${item.project_id}/videos/${item.id}`) },
                                                    { key: 'project', label: 'Open project', onClick: () => history.push(`/projects/${item.project_id}`) },
                                                ],
                                            }}
                                        >
                                            <Button type='text' className='cvat-video-task-actions'>
                                                <Typography.Text className='cvat-text-color'>Actions</Typography.Text>
                                                <MoreOutlined className='cvat-menu-icon' />
                                            </Button>
                                        </Dropdown>
                                    </Col>
                                </Row>
                            </Col>
                        </Row>
                    </List.Item>
                )}
            />
        </section>
    );
}
