package release;

import io.grpc.stub.StreamObserver;
import release.generated.ActivityServiceGrpc;
import release.generated.Wire;

class ActivityGrpcServer extends ActivityServiceGrpc.ActivityServiceImplBase {
  StreamObserver<Wire.CreateRequest> create(StreamObserver<Wire.CreateResponse> observer) { return null; }
}
