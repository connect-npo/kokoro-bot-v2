// LINE Webhook ハンドラ内、event.source.userId を取得した直後あたりに追記
events.forEach(async event => {
    if (!event.source || !event.source.userId) {
        console.warn("Event has no userId, skipping:", event);
        return;
    }
    const userId = event.source.userId;

    // ⭐追加: グループIDをログに出力する部分 ⭐
    if (event.source.type === 'group') {
        const currentGroupId = event.source.groupId;
        console.log(`💡 現在のグループからのイベント - グループID: ${currentGroupId}`);
        // 必要であれば、ここで OFFICER_GROUP_ID と currentGroupId を比較するログを追加しても良いでしょう
    }
    // ⭐ここまで追加 ⭐

    let userDoc;
    try {
        userDoc = await usersCollection.doc(userId).get();
    } catch (dbError) {
        // ... (既存のコード) ...
    }
    // ... (以降の既存コード) ...
});
