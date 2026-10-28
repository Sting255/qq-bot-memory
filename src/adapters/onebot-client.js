/**
 * OneBot 11 WebSocket 客户端。
 *
 * 采用正向 WS 连接（本程序连 NapCat 的服务端），断线按指数退避重连。
 * action 调用走同一个连接，按 echo 字段匹配响应。
 */
import WebSocket from 'ws';
import { createLogger } from '../logger.js';

const log = createLogger('onebot');

export class OneBotClient {
  constructor({ wsUrl, accessToken = '', reconnectBaseSec = 3, reconnectMaxSec = 60 }) {
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.reconnectBaseSec = reconnectBaseSec;
    this.reconnectMaxSec = reconnectMaxSec;

    this._ws = null;
    this._echoSeq = 0;
    this._pending = new Map(); // echo -> {resolve, reject, timer}
    this._reconnectAttempt = 0;
    this._closedByUser = false;
    this._messageHandlers = [];
    this._readyHandlers = [];
  }

  /** 注册消息事件回调。 */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /** 注册连接就绪回调。 */
  onReady(handler) {
    this._readyHandlers.push(handler);
  }

  connect() {
    this._closedByUser = false;
    const url = this.accessToken
      ? `${this.wsUrl}?access_token=${encodeURIComponent(this.accessToken)}`
      : this.wsUrl;

    log.info(`正在连接 ${this.wsUrl}`);
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      this._reconnectAttempt = 0;
      log.info('已连接 OneBot 服务端');
      for (const handler of this._readyHandlers) {
        try {
          handler();
        } catch (error) {
          log.error('就绪回调异常:', error.message);
        }
      }
    });

    ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        log.warn('收到非 JSON 数据，已忽略');
        return;
      }
      this._handlePayload(payload);
    });

    ws.on('close', (code, reason) => {
      log.warn(`连接关闭 code=${code} reason=${reason?.toString() || ''}`);
      this._rejectAllPending('连接已关闭');
      if (!this._closedByUser) this._scheduleReconnect();
    });

    ws.on('error', (error) => {
      log.error('连接错误:', error.message);
    });
  }

  _handlePayload(payload) {
    // action 响应
    if (payload.echo !== undefined && this._pending.has(payload.echo)) {
      const entry = this._pending.get(payload.echo);
      this._pending.delete(payload.echo);
      clearTimeout(entry.timer);
      if (payload.status === 'ok' || payload.retcode === 0) {
        entry.resolve(payload.data);
      } else {
        entry.reject(new Error(payload.message || payload.wording || 'action 调用失败'));
      }
      return;
    }

    // 事件推送
    if (payload.post_type) {
      for (const handler of this._messageHandlers) {
        try {
          handler(payload);
        } catch (error) {
          log.error('消息回调异常:', error.message);
        }
      }
    }
  }

  _scheduleReconnect() {
    this._reconnectAttempt += 1;
    const delay = Math.min(
      this.reconnectMaxSec,
      this.reconnectBaseSec * 2 ** (this._reconnectAttempt - 1),
    );
    log.info(`${delay}s 后重连（第 ${this._reconnectAttempt} 次）`);
    setTimeout(() => {
      if (!this._closedByUser) this.connect();
    }, delay * 1000);
  }

  _rejectAllPending(reason) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }

  /**
   * 调用 OneBot action。
   *
   * @param {string} action action 名称，如 send_group_msg
   * @param {object} params 参数
   * @param {number} [timeoutMs] 超时
   * @returns {Promise<object>} action 返回的 data
   */
  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('OneBot 连接未就绪'));
        return;
      }
      const echo = `req_${++this._echoSeq}`;
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`action ${action} 超时`));
      }, timeoutMs);

      this._pending.set(echo, { resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(echo);
        reject(error);
      }
    });
  }

  /** 发送群消息。 */
  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  /** 发送私聊消息。 */
  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  /**
   * 获取当前登录账号信息。
   * OneBot 11 标准 action，返回 { user_id, nickname }。
   */
  getLoginInfo() {
    return this.call('get_login_info', {}, 10000);
  }

  close() {
    this._closedByUser = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._rejectAllPending('客户端已关闭');
  }
}
