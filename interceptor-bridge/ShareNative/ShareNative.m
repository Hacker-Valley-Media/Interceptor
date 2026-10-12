#import "ShareNative.h"

NSError *InterceptorContactOperation(void (^operation)(void)) {
    return InterceptorNativeOperation(@"Contacts", operation);
}

NSError *InterceptorNativeOperation(NSString *scope, void (^operation)(void)) {
    @try {
        operation();
        return nil;
    } @catch (NSException *exception) {
        return [NSError errorWithDomain:[NSString stringWithFormat:@"Interceptor%@Exception", scope] code:1
                              userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Native operation raised an exception",
                                         @"exceptionName": exception.name}];
    }
}

NSDictionary<NSString *, id> *InterceptorPhotoHistory(PHPhotoLibrary *library, PHPersistentChangeToken *token, NSUInteger limit) {
    @try {
        NSError *error = nil;
        PHPersistentChangeFetchResult *result = [library fetchPersistentChangesSinceToken:token error:&error];
        if (error || !result) return @{@"nativeError": error ?: [NSError errorWithDomain:@"InterceptorPhotosHistory" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Native Photos history returned no result"}]};
        NSMutableArray *events = [NSMutableArray array];
        __block PHPersistentChangeToken *last = token;
        __block NSError *failure = nil;
        __block NSUInteger identifiers = 0, changes = 0;
        [result enumerateChangesWithBlock:^(PHPersistentChange *change, BOOL *stop) {
            if (++changes > 1000) { failure = [NSError errorWithDomain:@"InterceptorPhotosHistoryLimit" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Photos history exceeds 1000 native changes; token was not advanced"}]; *stop = YES; return; }
            for (NSNumber *kind in @[@(PHObjectTypeAsset), @(PHObjectTypeAssetCollection), @(PHObjectTypeCollectionList)]) {
                NSError *detailError = nil;
                PHPersistentObjectChangeDetails *details = [change changeDetailsForObjectType:kind.integerValue error:&detailError];
                if (detailError || !details) { failure = detailError ?: [NSError errorWithDomain:@"InterceptorPhotosHistory" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Native Photos object change details are missing"}]; *stop = YES; return; }
                identifiers += details.insertedLocalIdentifiers.count + details.updatedLocalIdentifiers.count + details.deletedLocalIdentifiers.count;
                if (identifiers > limit) { failure = [NSError errorWithDomain:@"InterceptorPhotosHistoryLimit" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Photos history exceeds identifier budget; token was not advanced"}]; *stop = YES; return; }
                if (details.insertedLocalIdentifiers.count + details.updatedLocalIdentifiers.count + details.deletedLocalIdentifiers.count) {
                    NSString *name = kind.integerValue == PHObjectTypeAsset ? @"asset" : kind.integerValue == PHObjectTypeAssetCollection ? @"assetCollection" : @"collectionList";
                    [events addObject:@{@"objectType": name,
                        @"inserted": [details.insertedLocalIdentifiers.allObjects sortedArrayUsingSelector:@selector(compare:)],
                        @"updated": [details.updatedLocalIdentifiers.allObjects sortedArrayUsingSelector:@selector(compare:)],
                        @"deleted": [details.deletedLocalIdentifiers.allObjects sortedArrayUsingSelector:@selector(compare:)]}];
                }
            }
            last = change.changeToken;
        }];
        if (failure) return @{@"nativeError": failure};
        NSData *bytes = [NSKeyedArchiver archivedDataWithRootObject:last requiringSecureCoding:YES error:&error];
        if (error || !bytes || bytes.length > 49152) return @{@"nativeError": error ?: [NSError errorWithDomain:@"InterceptorPhotosHistoryLimit" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Photos history token is missing or exceeds 48KiB"}]};
        return @{@"events": events, @"currentToken": [bytes base64EncodedStringWithOptions:0]};
    } @catch (NSException *exception) {
        return @{@"nativeError": [NSError errorWithDomain:@"InterceptorPhotosHistoryException" code:1 userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Native Photos history raised an exception", @"exceptionName": exception.name}]};
    }
}

NSError *InterceptorPerformShare(NSSharingService *service, NSArray *items) {
    @try {
        [service performWithItems:items];
        return nil;
    } @catch (NSException *exception) {
        return [NSError errorWithDomain:@"InterceptorSharingServiceException" code:1
                              userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Native sharing service raised an exception",
                                         @"exceptionName": exception.name}];
    }
}

NSDictionary<NSString *, id> *InterceptorContactHistory(CNContactStore *store, CNChangeHistoryFetchRequest *request, NSUInteger limit) {
    @try {
        NSError *error = nil;
        CNFetchResult<NSEnumerator<CNChangeHistoryEvent *> *> *result = [store enumeratorForChangeHistoryFetchRequest:request error:&error];
        if (error || !result) return @{@"nativeError": error ?: [NSError errorWithDomain:@"InterceptorContactHistory" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Native Contacts history returned no result"}]};
        NSMutableArray<CNChangeHistoryEvent *> *events = [NSMutableArray array];
        for (CNChangeHistoryEvent *event in result.value) {
            if (events.count >= limit) return @{@"code": @"resource_limit", @"error": @"Contacts history exceeds the requested limit; the history token was not advanced"};
            [events addObject:event];
        }
        return @{@"events": events, @"currentToken": [result.currentHistoryToken base64EncodedStringWithOptions:0] ?: [NSNull null]};
    } @catch (NSException *exception) {
        return @{@"nativeError": [NSError errorWithDomain:@"InterceptorContactHistoryException" code:1 userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Native Contacts history raised an exception", @"exceptionName": exception.name}]};
    }
}
