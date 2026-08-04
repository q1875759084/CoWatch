import { useImperativeHandle, forwardRef } from 'react';
import { Form, Radio, App } from 'antd';
import type { RecordingSettings } from '@/types/settings';

export interface RecordingPanelHandle {
  handleSave: () => Promise<void>;
}

const RecordingPanel = forwardRef<RecordingPanelHandle, { values: RecordingSettings }>(
  function RecordingPanel({ values }, ref) {
    const [form] = Form.useForm<RecordingSettings>();
    const { message } = App.useApp();

    const handleSave = async () => {
      try {
        const v = await form.validateFields();
        await window.electronBridge!.settings!.set('recording', v);
        message.success('录制设置已保存');
      } catch (err) {
        if ((err as { errorFields?: unknown }).errorFields) return;
        message.error('保存失败：' + (err as Error).message);
        throw err;
      }
    };

    useImperativeHandle(ref, () => ({ handleSave }), [form, message]);

    return (
      <Form form={form} layout="vertical" initialValues={values}>
        <Form.Item name="resolution" label="分辨率" rules={[{ required: true, message: '请选择分辨率' }]}>
          <Radio.Group>
            <Radio value="720p">720p（1280×720）</Radio>
            <Radio value="900p">900p（1600×900）</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item name="fps" label="帧率" rules={[{ required: true, message: '请选择帧率' }]}>
          <Radio.Group>
            <Radio value={30}>30 fps</Radio>
            <Radio value={60}>60 fps</Radio>
          </Radio.Group>
        </Form.Item>
      </Form>
    );
  },
);

export default RecordingPanel;
