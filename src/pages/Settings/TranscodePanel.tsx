import { useImperativeHandle, forwardRef } from 'react';
import { Form, Radio, App } from 'antd';
import type { TranscodeSettings } from '@/types/settings';

export interface TranscodePanelHandle {
  handleSave: () => Promise<void>;
}

const TranscodePanel = forwardRef<TranscodePanelHandle, { values: TranscodeSettings }>(
  function TranscodePanel({ values }, ref) {
    const [form] = Form.useForm<TranscodeSettings>();
    const { message } = App.useApp();

    const handleSave = async () => {
      try {
        const v = await form.validateFields();
        await window.electronBridge!.settings!.set('transcode', v);
        message.success('转码设置已保存');
      } catch (err) {
        if ((err as { errorFields?: unknown }).errorFields) return;
        message.error('保存失败：' + (err as Error).message);
        throw err;
      }
    };

    useImperativeHandle(ref, () => ({ handleSave }), [form, message]);

    return (
      <Form form={form} layout="vertical" initialValues={values}>
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

export default TranscodePanel;
