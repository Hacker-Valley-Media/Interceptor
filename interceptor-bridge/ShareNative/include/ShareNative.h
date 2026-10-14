#import <AppKit/AppKit.h>
#import <Contacts/Contacts.h>
#import <Photos/Photos.h>

// Share's direct native call runs inside Objective-C. Generic operation blocks
// may enter Swift; this declaration does not qualify Swift unwinding/recovery.
FOUNDATION_EXPORT NSError * _Nullable InterceptorPerformShare(NSSharingService * _Nonnull service, NSArray * _Nonnull items);
FOUNDATION_EXPORT NSDictionary<NSString *, id> * _Nonnull InterceptorContactHistory(CNContactStore * _Nonnull store, CNChangeHistoryFetchRequest * _Nonnull request, NSUInteger limit);
FOUNDATION_EXPORT NSError * _Nullable InterceptorContactOperation(void (^ _Nonnull operation)(void));
FOUNDATION_EXPORT NSError * _Nullable InterceptorNativeOperation(NSString * _Nonnull scope, void (^ _Nonnull operation)(void));
FOUNDATION_EXPORT NSDictionary<NSString *, id> * _Nonnull InterceptorPhotoHistory(PHPhotoLibrary * _Nonnull library, PHPersistentChangeToken * _Nonnull token, NSUInteger limit) API_AVAILABLE(macos(13));
