const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLoginCodeResponse } = require('../dist/services/wx-login/native-protocol');
const { classifyProtocolError } = require('../dist/services/wx-login/recovery-policy');

/** protobuf varint（负数按 64 位补码编码，和 Go 的 protowire 读出来再截断 int32 等价）。 */
function varint(value) {
    let v = BigInt.asUintN(64, BigInt(value));
    const out = [];
    do {
        let byte = Number(v & 0x7Fn);
        v >>= 7n;
        if (v) byte |= 0x80;
        out.push(byte);
    } while (v);
    return Buffer.from(out);
}

function fieldBytes(field, payload) {
    return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

function fieldVarint(field, value) {
    return Buffer.concat([varint(field * 8), varint(value)]);
}

/** 按 JSLoginResponse 的结构拼一层：外层 field 2 → { BaseResponse, Result, code }。 */
function response({ baseRet, resultRet, code } = {}) {
    const inner = [];
    if (baseRet !== undefined) inner.push(fieldBytes(1, fieldVarint(1, baseRet)));
    if (resultRet !== undefined) inner.push(fieldBytes(2, fieldVarint(1, resultRet)));
    if (code !== undefined) inner.push(fieldBytes(3, Buffer.from(code)));
    return fieldBytes(2, Buffer.concat(inner));
}

test('正常响应：ret 全为 0 时返回 code', () => {
    const plain = response({ baseRet: 0, resultRet: 0, code: 'the-code' });
    assert.equal(parseLoginCodeResponse(plain), 'the-code');
});

test('业务拒绝：BaseResponse.ret = -14 时抛 -14，而不是「找不到 code」', () => {
    const plain = response({ baseRet: -14, resultRet: 0 });
    assert.throws(() => parseLoginCodeResponse(plain), /jslogin_business rejected: code=-14/);
    const info = classifyProtocolError(new Error('wx.login jslogin_business rejected: code=-14'));
    assert.equal(info.kind, 'application_rejected');
    assert.equal(info.definitive, false, '-14 不能当成凭证失效去重新登录');
});

test('业务拒绝优先：即使响应里同时带了一个 code，也以 ret 为准', () => {
    const plain = response({ baseRet: -14, code: 'looks-valid' });
    assert.throws(() => parseLoginCodeResponse(plain), /rejected: code=-14/);
});

test('二级结果拒绝：JSAPI Result.ret 非 0 也会被判为拒绝', () => {
    const plain = response({ baseRet: 0, resultRet: -1 });
    assert.throws(() => parseLoginCodeResponse(plain), /jslogin_result rejected: code=-1/);
});

test('既没有 code 也没有 ret 时返回 null，交给上层换接入点重试', () => {
    assert.equal(parseLoginCodeResponse(response({ baseRet: 0 })), null);
});
