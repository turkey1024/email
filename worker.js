addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

// 过期时间映射（分钟=>毫秒）
const EXPIRY_MAPPING = {
    '10': 10 * 60 * 1000,    // 10分钟
    '60': 60 * 60 * 1000,    // 1小时
    '300': 5 * 60 * 60 * 1000, // 5小时
    '1440': 24 * 60 * 60 * 1000, // 24小时
    '10080': 7 * 24 * 60 * 60 * 1000 // 7天
}

async function handleRequest(request) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/register') {
        return handleRegister(request);
    }
    return new Response(JSON.stringify({ error: 'Not Found' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleRegister(request) {
    try {
        const { prefix, targetEmail, emailType, expiryMinutes } = await request.json();
        
        // 验证输入
        if (!/^[a-z0-9-]+$/.test(prefix)) {
            return jsonResponse({ error: '前缀只能包含小写字母、数字和横线' }, 400);
        }
        
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
            return jsonResponse({ error: '无效的目标邮箱格式' }, 400);
        }

        // 创建转发规则
        const ruleResponse = await createForwardingRule(prefix, targetEmail);
        if (!ruleResponse.success) {
            return jsonResponse({ 
                error: '创建转发规则失败: ' + 
                (ruleResponse.errors?.[0]?.message || '未知错误') 
            });
        }

        // 如果是临时邮箱，在KV中存储过期时间
        if (emailType === 'temporary' && expiryMinutes) {
            const expiryMs = EXPIRY_MAPPING[expiryMinutes] || EXPIRY_MAPPING['60'];
            const expiryTimestamp = Date.now() + expiryMs;
            await EMAIL_EXPIRY_KV.put(
                `${prefix}@qxz.qzz.io`, 
                expiryTimestamp.toString(),
                { expiration: Math.floor(expiryTimestamp / 1000) } // TTL自动过期
            );
        }

        return jsonResponse({ 
            success: true,
            email: `${prefix}@qxz.qzz.io`,
            expiry: emailType === 'temporary' ? 
                   `将在${formatExpiryText(expiryMinutes)}后过期` : 
                   '永久有效'
        });
    } catch (error) {
        return jsonResponse({ error: '服务器错误: ' + error.message }, 500);
    }
}

function formatExpiryText(minutes) {
    const mins = parseInt(minutes);
    if (mins === 10) return '10分钟';
    if (mins === 60) return '1小时';
    if (mins === 300) return '5小时';
    if (mins === 1440) return '24小时';
    if (mins === 10080) return '7天';
    return '';
}

async function createForwardingRule(prefix, targetEmail) {
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                matchers: [{
                    type: 'literal',
                    field: 'to',
                    value: `${prefix}@qxz.qzz.io`
                }],
                actions: [{
                    type: 'forward',
                    value: [targetEmail]
                }],
                enabled: true,
                priority: 10
            })
        }
    );
    return await response.json();
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        }
    });
}

// 定时任务处理过期邮箱
addEventListener('scheduled', event => {
    event.waitUntil(handleExpiredEmails());
});

async function handleExpiredEmails() {
    const now = Date.now();
    const keys = await EMAIL_EXPIRY_KV.list();
    
    for (const key of keys.keys) {
        const expiry = await EMAIL_EXPIRY_KV.get(key.name);
        if (expiry && parseInt(expiry) < now) {
            await deleteForwardingRule(key.name);
            await EMAIL_EXPIRY_KV.delete(key.name);
        }
    }
}

async function deleteForwardingRule(email) {
    // 获取规则ID
    const rules = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules?enabled=true`,
        { headers: { 'Authorization': `Bearer ${API_TOKEN}` } }
    ).then(r => r.json());
    
    const rule = rules.result?.find(r => 
        r.matchers?.[0]?.type === 'literal' && 
        r.matchers?.[0]?.value === email
    );
    
    if (rule?.id) {
        await fetch(
            `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules/${rule.id}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${API_TOKEN}` }
            }
        );
    }
}

