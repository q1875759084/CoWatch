import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Tabs, Form, Input, Button } from 'antd';
import { createRoomApi, joinRoomApi } from '@/api/room';

type ModalTab = 'create' | 'join';

interface RoomModalProps {
  onClose: () => void;
  /** 加入/创建成功后刷新房间列表 */
  onSuccess: () => void;
}

/**
 * 创建 / 加入房间弹窗
 */
export function RoomModal({ onClose, onSuccess }: RoomModalProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ModalTab>('create');
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<{ roomName?: string; roomId?: string }>();

  const switchTab = (next: ModalTab) => {
    setTab(next);
    form.resetFields();
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      if (tab === 'create') {
        const result = await createRoomApi(values.roomName!.trim());
        onSuccess();
        navigate(`/room/${result.roomId}/lobby`);
      } else {
        await joinRoomApi(values.roomId!.trim());
        onSuccess();
        navigate(`/room/${values.roomId!.trim()}/lobby`);
      }
      onClose();
    } catch (err: unknown) {
      form.setFields([
        {
          name: tab === 'create' ? 'roomName' : 'roomId',
          errors: [err instanceof Error ? err.message : '操作失败，请稍后重试'],
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      title={tab === 'create' ? '创建新房间' : '加入房间'}
      onCancel={onClose}
      footer={
        <Button type="primary" loading={loading} onClick={() => void handleSubmit()}>
          {tab === 'create' ? '立即创建' : '加入房间'}
        </Button>
      }
      width={360}
      destroyOnHidden
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => switchTab(key as ModalTab)}
        items={[
          { key: 'create', label: '创建房间' },
          { key: 'join', label: '加入房间' },
        ]}
      />

      <Form form={form} layout="vertical" onFinish={() => void handleSubmit()}>
        {tab === 'create' ? (
          <Form.Item
            name="roomName"
            rules={[
              { required: true, message: '请输入房间名' },
              { max: 10, message: '房间名最多 10 个字符' },
            ]}
          >
            <Input
              placeholder="输入房间名，最多 10 个字符"
              maxLength={10}
              autoFocus
            />
          </Form.Item>
        ) : (
          <Form.Item
            name="roomId"
            rules={[{ required: true, message: '请输入房间码' }]}
          >
            <Input
              placeholder="输入房间码（6位字母/数字）"
              autoFocus
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
