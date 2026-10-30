export default {
  status: {
    error: '错误', attention: '待处理', working: '运行中', done: '已完成', idle: '空闲', unknown: '未报告状态',
  },
  connection: {
    disconnected: '终端连接已断开', expired: '登录已失效', failed: '终端连接失败', removed: '连接已移除',
    timeout: '终端连接超时', connecting: '连接中', interrupted: '连接中断', reconnect: '重连', reconnecting: '重连中 {attempt}/3',
  },
  upload: {
    file: '上传文件', failed: '上传失败', disconnected: '终端未连接', invalidSize: '文件大小无效', files: '{count} 个文件',
    preparing: '准备上传…', prepareTimeout: '上传准备超时', invalidUrl: '上传地址无效', cancelling: '取消中…',
    cancelled: '已取消', pathInserted: '已插入路径', cancel: '取消上传', close: '关闭上传状态', progress: '文件上传进度',
    foldersUnsupported: '暂不支持文件夹',
  },
  action: {
    addToCanvas: '加入画布', removeFromCanvas: '从画布移除', focus: '聚焦窗口', hideKeyboard: '隐藏键盘',
    showKeyboard: '打开键盘', windowActions: '窗口操作', restore: '退出放大', openWindow: '打开窗口 {name}',
  },
  clipboard: { failed: '复制失败', copied: '已复制', macPaste: '使用 ⌘V 粘贴' },
  keyboard: {
    input: '终端输入', arrowLeft: '向左', arrowDown: '向下', arrowUp: '向上', arrowRight: '向右',
    more: '更多按键', full: '完整键盘', functions: '功能键', numbers: '数字和符号', modifiers: '修改键和导航',
    rightShift: '右 Shift', rightAlt: '右 Alt', rightCtrl: '右 Ctrl', actions: '终端操作', pasteText: '粘贴文本',
    selectText: '选择文本', touchScroll: '触控滚动', touchMouse: '触控鼠标', helperKeys: '终端辅助键',
    terminalText: '终端文本', textToPaste: '待粘贴文本', longPressPaste: '长按粘贴', copySelection: '复制选中',
    copyAll: '复制全部', pasteIntoTerminal: '粘贴到终端',
  },
  unavailable: '窗口不可用', maximized: '已最大化', windowStatus: '窗口状态', statusSummary: '窗口状态：{status}',
  readOnly: '只读', pane: '窗格 {name}', copyDiagnostics: '复制调试数据', previewTitle: '标签页标题',
  tooMuchOutput: '输出内容过多，请查看终端行以继续阅读。',
}
