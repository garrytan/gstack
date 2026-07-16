//
//  DebugBridgeTouch.m — minimal port of KIF's in-process touch synthesis.
//  Original code: https://github.com/kif-framework/KIF — MIT-licensed
//  (Square, Inc. + KIF contributors). Adapted to a single-file, tap-only,
//  iOS 18+ aware subset for the gstack/ios-qa DebugBridge.
//
//  Uses these private UIKit selectors (DEBUG-only; never shipped to App Store):
//    UITouch:  _setLocationInWindow:resetPrevious:, _setIsFirstTouchForView:,
//              setPhase:, setTimestamp:, setView:, setWindow:, setTapCount:,
//              _setHidEvent:
//    UIEvent:  _clearTouches, _addTouch:forDelayedDelivery:, _setHIDEvent:
//    UIApplication: _touchesEvent
//    UIView:   _hitTestWithContext: (iOS 18+ for SwiftUI hit-testing)
//    NSObject: _UIHitTestContext contextWithPoint:radius: (iOS 18+)
//
//  IOKit private symbols (linked dynamically via the IOKit framework on iOS):
//    IOHIDEventCreateDigitizerEvent, IOHIDEventCreateDigitizerFingerEventWithQuality,
//    IOHIDEventSetIntegerValue, IOHIDEventAppendEvent.

#import "DebugBridgeTouch.h"
#import <TargetConditionals.h>

#if TARGET_OS_IOS

#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach/mach_time.h>

#pragma mark - IOHIDEvent (private symbols from IOKit)

typedef struct __IOHIDEvent * IOHIDEventRef;

#define IOHIDEventFieldBase(type) (type << 16)
#ifdef __LP64__
typedef double IOHIDFloat;
#else
typedef float IOHIDFloat;
#endif
typedef UInt32 IOOptionBits;
typedef uint32_t IOHIDDigitizerTransducerType;
typedef uint32_t IOHIDEventField;

enum {
    kIOHIDDigitizerTransducerTypeStylus = 0,
    kIOHIDDigitizerTransducerTypePuck,
    kIOHIDDigitizerTransducerTypeFinger,
    kIOHIDDigitizerTransducerTypeHand
};

enum {
    kIOHIDEventTypeDigitizer = 11,
};

enum {
    kIOHIDDigitizerEventRange    = 0x00000001,
    kIOHIDDigitizerEventTouch    = 0x00000002,
    kIOHIDDigitizerEventPosition = 0x00000004,
};

enum {
    kIOHIDEventFieldDigitizerX = IOHIDEventFieldBase(kIOHIDEventTypeDigitizer),
    kIOHIDEventFieldDigitizerY,
    kIOHIDEventFieldDigitizerZ,
    kIOHIDEventFieldDigitizerButtonMask,
    kIOHIDEventFieldDigitizerType,
    kIOHIDEventFieldDigitizerIndex,
    kIOHIDEventFieldDigitizerIdentity,
    kIOHIDEventFieldDigitizerEventMask,
    kIOHIDEventFieldDigitizerRange,
    kIOHIDEventFieldDigitizerTouch,
    kIOHIDEventFieldDigitizerPressure,
    kIOHIDEventFieldDigitizerAuxiliaryPressure,
    kIOHIDEventFieldDigitizerTwist,
    kIOHIDEventFieldDigitizerTiltX,
    kIOHIDEventFieldDigitizerTiltY,
    kIOHIDEventFieldDigitizerAltitude,
    kIOHIDEventFieldDigitizerAzimuth,
    kIOHIDEventFieldDigitizerQuality,
    kIOHIDEventFieldDigitizerDensity,
    kIOHIDEventFieldDigitizerIrregularity,
    kIOHIDEventFieldDigitizerMajorRadius,
    kIOHIDEventFieldDigitizerMinorRadius,
    kIOHIDEventFieldDigitizerCollection,
    kIOHIDEventFieldDigitizerCollectionChord,
    kIOHIDEventFieldDigitizerChildEventMask,
    kIOHIDEventFieldDigitizerIsDisplayIntegrated,
};

// IOKit is a PRIVATE framework on iOS — we can't link it via -framework. Load
// at runtime via dlopen/dlsym. This is the standard approach for KIF-style
// touch synthesis on iOS, including in DEBUG-only test harnesses.
#import <dlfcn.h>

typedef IOHIDEventRef (*IOHIDEventCreateDigitizerEventFn)(CFAllocatorRef, AbsoluteTime,
    IOHIDDigitizerTransducerType, uint32_t, uint32_t, uint32_t, uint32_t,
    IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, Boolean, Boolean, IOOptionBits);

typedef IOHIDEventRef (*IOHIDEventCreateDigitizerFingerEventWithQualityFn)(CFAllocatorRef,
    AbsoluteTime, uint32_t, uint32_t, uint32_t, IOHIDFloat, IOHIDFloat, IOHIDFloat,
    IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat,
    IOHIDFloat, Boolean, Boolean, IOOptionBits);

typedef void (*IOHIDEventSetIntegerValueFn)(IOHIDEventRef, IOHIDEventField, int);
typedef void (*IOHIDEventAppendEventFn)(IOHIDEventRef, IOHIDEventRef);

static IOHIDEventCreateDigitizerEventFn _IOHIDEventCreateDigitizerEvent;
static IOHIDEventCreateDigitizerFingerEventWithQualityFn _IOHIDEventCreateDigitizerFingerEventWithQuality;
static IOHIDEventSetIntegerValueFn _IOHIDEventSetIntegerValue;
static IOHIDEventAppendEventFn _IOHIDEventAppendEvent;

static BOOL _IOKitLoaded = NO;
static BOOL DBT_LoadIOKit(void) {
    if (_IOKitLoaded) return YES;
    void *handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
    if (!handle) {
        handle = dlopen("/System/Library/PrivateFrameworks/IOKit.framework/IOKit", RTLD_NOW);
    }
    if (!handle) return NO;
    _IOHIDEventCreateDigitizerEvent = (IOHIDEventCreateDigitizerEventFn)dlsym(handle, "IOHIDEventCreateDigitizerEvent");
    _IOHIDEventCreateDigitizerFingerEventWithQuality = (IOHIDEventCreateDigitizerFingerEventWithQualityFn)dlsym(handle, "IOHIDEventCreateDigitizerFingerEventWithQuality");
    _IOHIDEventSetIntegerValue = (IOHIDEventSetIntegerValueFn)dlsym(handle, "IOHIDEventSetIntegerValue");
    _IOHIDEventAppendEvent = (IOHIDEventAppendEventFn)dlsym(handle, "IOHIDEventAppendEvent");
    _IOKitLoaded = (_IOHIDEventCreateDigitizerEvent && _IOHIDEventCreateDigitizerFingerEventWithQuality &&
                    _IOHIDEventSetIntegerValue && _IOHIDEventAppendEvent);
    return _IOKitLoaded;
}

// KIF enables accessibility automation before it asks UIKit/SwiftUI for the
// accessibility tree. Without this switch SwiftUI exposes only its hosting
// shell: /elements has no controls and a synthesized tap can return YES while
// Button.action never fires. Keep this DEBUG-only with the rest of this file.
typedef int (*DBTAXSAutomationEnabledFn)(void);
typedef void (*DBTAXSSetAutomationEnabledFn)(int);
static DBTAXSAutomationEnabledFn _DBTAXSAutomationEnabled;
static DBTAXSSetAutomationEnabledFn _DBTAXSSetAutomationEnabled;
static int _DBTInitialAutomationState = -1;

static void DBT_RestoreAccessibilityAutomation(void) {
    if (_DBTAXSSetAutomationEnabled && _DBTInitialAutomationState >= 0) {
        _DBTAXSSetAutomationEnabled(_DBTInitialAutomationState);
    }
}

static void DBT_EnableAccessibilityAutomation(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        void *handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW | RTLD_LOCAL);
        if (!handle) return;
        _DBTAXSAutomationEnabled = (DBTAXSAutomationEnabledFn)dlsym(handle, "_AXSAutomationEnabled");
        _DBTAXSSetAutomationEnabled = (DBTAXSSetAutomationEnabledFn)dlsym(handle, "_AXSSetAutomationEnabled");
        if (!_DBTAXSAutomationEnabled || !_DBTAXSSetAutomationEnabled) return;
        _DBTInitialAutomationState = _DBTAXSAutomationEnabled();
        if (!_DBTInitialAutomationState) _DBTAXSSetAutomationEnabled(1);
        atexit(DBT_RestoreAccessibilityAutomation);
    });
}

static IOHIDEventRef DBT_IOHIDEventWithTouch(UITouch *touch) CF_RETURNS_RETAINED;
static IOHIDEventRef DBT_IOHIDEventWithTouch(UITouch *touch) {
    if (!DBT_LoadIOKit()) return NULL;
    uint64_t abTime = mach_absolute_time();
    AbsoluteTime timeStamp;
    timeStamp.hi = (UInt32)(abTime >> 32);
    timeStamp.lo = (UInt32)(abTime);

    IOHIDEventRef handEvent = _IOHIDEventCreateDigitizerEvent(kCFAllocatorDefault,
        timeStamp, kIOHIDDigitizerTransducerTypeHand,
        0, 0, kIOHIDDigitizerEventTouch, 0,
        0, 0, 0, 0, 0,
        0, true, 0);
    _IOHIDEventSetIntegerValue(handEvent, kIOHIDEventFieldDigitizerIsDisplayIntegrated, 1);

    uint32_t eventMask = (touch.phase == UITouchPhaseMoved)
        ? kIOHIDDigitizerEventPosition
        : (kIOHIDDigitizerEventRange | kIOHIDDigitizerEventTouch);
    uint32_t isTouching = (touch.phase == UITouchPhaseEnded) ? 0 : 1;

    CGPoint loc = [touch locationInView:touch.window];

    IOHIDEventRef fingerEvent = _IOHIDEventCreateDigitizerFingerEventWithQuality(kCFAllocatorDefault,
        timeStamp, 1, 2, eventMask,
        (IOHIDFloat)loc.x, (IOHIDFloat)loc.y, 0.0,
        0, 0, 5.0, 5.0, 1.0, 1.0, 1.0,
        (IOHIDFloat)isTouching, (IOHIDFloat)isTouching, 0);
    _IOHIDEventSetIntegerValue(fingerEvent, kIOHIDEventFieldDigitizerIsDisplayIntegrated, 1);

    _IOHIDEventAppendEvent(handEvent, fingerEvent);
    CFRelease(fingerEvent);

    return handEvent;
}

#pragma mark - Private selectors

@interface UITouch ()
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setPhase:(UITouchPhase)touchPhase;
- (void)setGestureView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)firstTouchForView;
- (void)_setIsTapToClick:(BOOL)tapToClick;
- (void)_setHidEvent:(IOHIDEventRef)event;
@end

@interface UIEvent (DBTPrivate)
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_setHIDEvent:(IOHIDEventRef)event;
- (void)_setTimestamp:(NSTimeInterval)timestamp;
@end

@interface UIApplication (DBTPrivate)
- (UIEvent *)_touchesEvent;
@end

@interface UIView (DBTPrivate)
- (id)_hitTestWithContext:(id)context;
@end

#pragma mark - SwiftUI-aware hit test (iOS 18+)

// Returns `id` because iOS 18's _hitTestWithContext: can return either a UIView
// OR a SwiftUI.UIKitGestureContainer (a plain UIResponder, NOT a UIView).
// The latter is the case for SwiftUI Buttons. KIF's observation: the returned
// responder is still compatible with UITouch.setView: even when it isn't a
// UIView — so we pass it through as-is. Filtering by isKindOfClass:UIView
// here would drop every SwiftUI Button tap silently. Mirrors KIF PR #1323.
static id DBT_HitTestView(UIWindow *window, CGPoint point) {
    UIView *fallback = [window hitTest:point withEvent:nil];

    if (@available(iOS 18.0, *)) {
        Class ctxClass = NSClassFromString(@"_UIHitTestContext");
        SEL ctxSel = NSSelectorFromString(@"contextWithPoint:radius:");
        if (ctxClass && [ctxClass respondsToSelector:ctxSel] &&
            [UIView instancesRespondToSelector:@selector(_hitTestWithContext:)]) {
            id (*sendCtx)(id, SEL, CGPoint, CGFloat) =
                (id (*)(id, SEL, CGPoint, CGFloat))objc_msgSend;
            id ctx = sendCtx(ctxClass, ctxSel, point, 0);
            if (ctx) {
                id found = nil;
                UIView *current = fallback;
                while (found == nil && current != nil) {
                    found = [current _hitTestWithContext:ctx];
                    current = current.superview;
                }
                if (found) {
                    return found;
                }
            }
        }
    }
    return fallback;
}

#pragma mark - Public API

@implementation DebugBridgeTouch

+ (void)prepareForAutomation {
    DBT_EnableAccessibilityAutomation();
}

+ (BOOL)sendTapAtPoint:(CGPoint)point inWindow:(UIWindow *)window {
    if (!window) return NO;

    id hit = DBT_HitTestView(window, point);
    if (!hit) return NO;

    // Build a single synthetic UITouch via private setters. Order matters —
    // setWindow: clears internal state and must come first.
    UITouch *touch = [[UITouch alloc] init];
    [touch setWindow:window];
    [touch setTapCount:1];
    [touch _setLocationInWindow:point resetPrevious:YES];
    // setView: typed UIView * but accepts SwiftUI.UIKitGestureContainer
    // (UIResponder) too — that's how SwiftUI Buttons get routed on iOS 18+.
    [touch setView:(UIView *)hit];
    [touch setPhase:UITouchPhaseBegan];
    if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) {
        [touch _setIsFirstTouchForView:YES];
    } else if ([touch respondsToSelector:@selector(_setIsTapToClick:)]) {
        [touch _setIsTapToClick:YES];
        Ivar flagsIvar = class_getInstanceVariable([UITouch class], "_touchFlags");
        if (flagsIvar) {
            ptrdiff_t offset = ivar_getOffset(flagsIvar);
            char *flags = (__bridge void *)touch + offset;
            *flags |= (char)0x01;
        }
    }
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    if ([touch respondsToSelector:@selector(setGestureView:)]) {
        [touch setGestureView:(UIView *)hit];
    }

    // Attach a real IOHIDEvent (required iOS 9+).
    IOHIDEventRef hidEventBegan = DBT_IOHIDEventWithTouch(touch);
    [touch _setHidEvent:hidEventBegan];

    UIEvent *event = [[UIApplication sharedApplication] _touchesEvent];
    if (!event) {
        CFRelease(hidEventBegan);
        return NO;
    }
    [event _clearTouches];
    [event _setHIDEvent:hidEventBegan];
    [event _addTouch:touch forDelayedDelivery:NO];

    [[UIApplication sharedApplication] sendEvent:event];
    CFRelease(hidEventBegan);

    // Ended phase
    [touch setPhase:UITouchPhaseEnded];
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    IOHIDEventRef hidEventEnded = DBT_IOHIDEventWithTouch(touch);
    [touch _setHidEvent:hidEventEnded];
    [event _clearTouches];
    [event _setHIDEvent:hidEventEnded];
    [event _addTouch:touch forDelayedDelivery:NO];
    [[UIApplication sharedApplication] sendEvent:event];
    CFRelease(hidEventEnded);

    return YES;
}

@end

#else // !TARGET_OS_IOS

// macOS / Catalyst / other non-iOS host build: no-op stub so the module
// resolves cleanly without UIKit or IOKit. The Swift cross-platform tests
// don't exercise touch synthesis; that's iOS-only by definition.
@implementation DebugBridgeTouch
+ (BOOL)sendTapAtPoint:(CGPoint)point inWindow:(UIWindow *)window {
    (void)point; (void)window;
    return NO;
}
@end

#endif // TARGET_OS_IOS
