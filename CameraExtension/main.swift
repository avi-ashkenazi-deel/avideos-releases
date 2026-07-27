//
//  main.swift
//  CameraExtension — streamit virtual camera (CoreMediaIO system extension)
//
//  Entry point. A CMIO extension is a faceless XPC service: we build the
//  provider hierarchy (provider → device → streams), hand it to
//  CMIOExtensionProvider.startService, and then park the main thread in a
//  run loop forever. The system starts/stops this process on demand.
//

import Foundation
import CoreMediaIO

// Keep the provider source alive for the lifetime of the process.
let providerSource = ExtensionProviderSource(clientQueue: nil)

CMIOExtensionProvider.startService(provider: providerSource.provider)

CFRunLoopRun()
