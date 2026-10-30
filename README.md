<p align="center">
  <img src="/site/content/en/images/cvat-readme-gif.gif" alt="CVAT Platform" width="100%" max-width="800px">
</p>
<p align="center">
  <a href="https://app.cvat.ai/">
    <img src="/site/content/en/images/cvat-readme-button-tr-bg.png" alt="Start Annotating Now">
  </a>
</p>

# Computer Vision Annotation Tool (CVAT)

[![CI][ci-img]][ci-url]
[![Gitter chat][gitter-img]][gitter-url]
[![Discord][discord-img]][discord-url]
[![Coverage Status][coverage-img]][coverage-url]
[![server pulls][docker-server-pulls-img]][docker-server-image-url]
[![ui pulls][docker-ui-pulls-img]][docker-ui-image-url]
[![DOI][doi-img]][doi-url]
[![Status][status-img]][status-url]

CVAT is an interactive video and image annotation
tool for computer vision. It is used by tens of thousands of users and
companies around the world. Our mission is to help developers, companies, and
organizations around the world to solve real problems using the Data-centric
AI approach.

Start using CVAT online: [cvat.ai](https://cvat.ai). You can use it for free,
or [subscribe](https://www.cvat.ai/pricing/cloud) to get unlimited data,
organizations, autoannotations, and [Roboflow and HuggingFace integration](https://www.cvat.ai/post/integrating-hugging-face-and-roboflow-models).

Or set CVAT up as a self-hosted solution:
[Self-hosted Installation Guide](https://docs.cvat.ai/docs/administration/basics/installation/).
We provide [Enterprise support](https://www.cvat.ai/pricing/on-prem) for
self-hosted installations with premium features: SSO, LDAP, Roboflow and
HuggingFace integrations, and advanced analytics (coming soon). We also
do trainings and a dedicated support with 24 hour SLA.

## SAM2 video annotation

See [browser annotation, GPU setup, and export format](components/sam2/README.md)
for the new **SAM2 Video** workflow.

## Original MP4 annotation

On **Create task**, select a project, one local H.264 MP4, and **Original MP4
annotation**. **Upload & Open Original Video** creates a native CVAT Task/Job
backed by that MP4 and opens the standard annotation workspace. Existing
`/projects/<id>/videos/<uuid>` links open the associated native job.

Video tasks use the same cards and task lists as other CVAT tasks, below project
details. The workspace uses CVAT's original tools, label types, attributes,
undo/redo, grouping, merging, splitting, mask brushes/erasers, dataset import/
export, and SAM2 integration. Tool availability follows compatible project labels
and the current shape/track selection, exactly as in other jobs. The navigation
slider and position input show seconds using MP4 presentation timestamps,
including variable frame-rate videos; annotations retain exact sample indices.

The original MP4 remains intact. Upload indexes packet timestamps without
extracting frames. The browser decodes the original MP4 for the annotation
canvas. Server-side inference/export decodes only requested samples into memory.
The task raw-data directory contains a hard link to the same MP4, not an extra
copy or a directory of extracted images. Earlier rectangle/polygon time-interval
annotations are preserved as native tracks when their workspace is initialized.
Native edits are saved through `/api/jobs/<job-id>/annotations`.

The SAM2 Compose service defaults to `SAM2_DEVICE=auto`: it uses CUDA when at
least 3 GiB is available, otherwise CPU. Set `SAM2_DEVICE=cuda` or `cpu` to pin
the device; `SAM2_CPU_THREADS` defaults to 8. CPU inference is slower. In the
workspace, draw mask/polygon shapes, open **SAM2 Video**, select the objects and
range, run inference, review, then **Accept masks**. This does not interrupt other
GPU workloads.

SAM2 review uses separate source-image and mask layers. Manage results by run
and label, hide individual masks, adjust opacity, or delete generated masks.
Edge smoothing previews immediately and is saved only with **Apply smoothing**
for the selected mask/current frame. New runs do not generate composited preview
MP4s. Starting prompts and unrelated annotations are preserved during deletion.

The standard upload workflow remains available as **Standard frame annotation**.
Existing standard tasks are unchanged.

## Build and run this checkout

This machine stores CVAT data and build cache on D. Use the wrapper for builds
and updates so Compose selects the `sst-cvat-d` builder:

```bash
sudo ./utils/cvat-compose-d.sh build cvat_ui cvat_server
sudo ./utils/cvat-compose-d.sh up -d --no-build
```

`/mnt/D/docker-storage/docker-data.ext4` is a sparse 512 GiB ext4 image, mounted
at `/mnt/cvat-container-storage`. This preserves Linux filesystem semantics on
the NTFS D drive. `docker-compose.storage-d.yml` binds CVAT's database, uploads,
annotations, logs, keys, caches and SAM2 model cache to that mount. The dedicated
BuildKit cache is on the same mount and is limited to approximately 80 GB by GC.
The shared Docker engine and its final image store remain in their original
locations; unrelated projects are not moved. `/etc/fstab` and a Docker systemd
dependency ensure the storage is mounted before containers start after a reboot.
Do not remove or truncate the ext4 image: it contains the live CVAT data.

For other deployments without this machine's D storage setup:

Run from the repository root:

```bash
docker compose up -d
```

The main Compose file builds the CVAT UI and backend from this checkout on each
`up`, reusing Docker's build cache. All CVAT workers use the same backend image
and build configuration. PostgreSQL, Redis, and other infrastructure services use
prebuilt images. To rebuild without cached layers, run `docker compose build
--no-cache` before starting the services.

When reusing a database volume from a newer CVAT checkout, Compose enables
`CVAT_REPAIR_LEGACY_TASK_SCHEMA=yes` on the server. After Django migrations,
startup makes a leftover `engine_task.media_type` column nullable only if this
checkout does not define that field. This preserves existing values and prevents
task creation from failing with a NOT NULL violation. It is safe to repeat and
does nothing on a fresh database. This is a targeted compatibility repair, not a
general database downgrade; set the variable to `no` to disable it.

Keep using the same Compose project name and override files as the original
deployment to reuse its volumes. For this local development deployment:

```bash
docker compose -p sst_cvat -f docker-compose.yml -f docker-compose.dev.yml \
  -f components/serverless/docker-compose.serverless.yml up -d
```

The server runs database and Redis migrations during initialization; workers
wait for migrations before starting. Rebuilding does not downgrade a database
that has already been migrated by a newer CVAT version. Keep the code version and
database migration history aligned when switching versions.

For Remote SSH, forward remote port 8080 and open `http://localhost:8080` (or the
local port assigned by your SSH client). `CVAT_HOST` defaults to `localhost`.

When updating an existing installation, use its original Compose project name
and additional Compose files so that its volumes and integrations are preserved.
For example, the existing `sst_cvat` installation with serverless support uses:

```bash
docker compose -p sst_cvat -f docker-compose.yml -f docker-compose.dev.yml \
  -f components/serverless/docker-compose.serverless.yml up -d
```

## Quick start ⚡

- [Installation guide](https://docs.cvat.ai/docs/administration/basics/installation/)
- [Manual](https://docs.cvat.ai/docs/manual/)
- [Contributing](https://docs.cvat.ai/docs/contributing/)
- [Datumaro dataset framework](https://github.com/cvat-ai/datumaro/blob/develop/README.md)
- [Server API](#api)
- [Python SDK](#sdk)
- [Command line tool](#cli)
- [XML annotation format](https://docs.cvat.ai/docs/manual/advanced/xml_format/)
- [AWS Deployment Guide](https://docs.cvat.ai/docs/administration/basics/aws-deployment-guide/)
- [Frequently asked questions](https://docs.cvat.ai/docs/faq/)
- [Where to ask questions](#where-to-ask-questions)

## Partners ❤️

CVAT is used by teams all over the world. In the list, you can find key companies which
help us support the product or an essential part of our ecosystem. If you use us,
please drop us a line at [contact@cvat.ai](mailto:contact+github@cvat.ai).

- [Human Protocol](https://hmt.ai) uses CVAT as a way of adding annotation service to the Human Protocol.
- [FiftyOne](https://fiftyone.ai) is an open-source dataset curation and model analysis
  tool for visualizing, exploring, and improving computer vision datasets and models that are
  [tightly integrated](https://voxel51.com/docs/fiftyone/integrations/cvat.html) with CVAT
  for annotation and label refinement.

## Public datasets

[ATLANTIS](https://github.com/smhassanerfani/atlantis), an open-source dataset for semantic segmentation
of waterbody images, developed by [iWERS](http://ce.sc.edu/iwers/) group in the
Department of Civil and Environmental Engineering at the University of South Carolina is using CVAT.

For developing a semantic segmentation dataset using CVAT, see:

- [ATLANTIS published article](https://www.sciencedirect.com/science/article/pii/S1364815222000391)
- [ATLANTIS Development Kit](https://github.com/smhassanerfani/atlantis/tree/master/adk)
- [ATLANTIS annotation tutorial videos](https://www.youtube.com/playlist?list=PLIfLGY-zZChS5trt7Lc3MfNhab7OWl2BR).

## CVAT online: [cvat.ai](https://cvat.ai)

This is an online version of CVAT. It's free, efficient, and easy to use.

[cvat.ai](https://cvat.ai) runs the latest version of the tool. You can create up
to 10 tasks there and upload up to 500Mb of data to annotate. It will only be
visible to you or the people you assign to it.

For now, it does not have [analytics features](https://docs.cvat.ai/docs/administration/advanced/analytics/)
like management and monitoring the data annotation team. It also does not allow exporting images, just the annotations.

We plan to enhance [cvat.ai](https://cvat.ai) with new powerful features. Stay tuned!

## Prebuilt Docker images 🐳

Prebuilt docker images are the easiest way to start using CVAT locally. They are available on Docker Hub:

- [cvat/server](https://hub.docker.com/r/cvat/server)
- [cvat/ui](https://hub.docker.com/r/cvat/ui)

The images have been downloaded more than 1M times so far.

## Screencasts 🎦

Here are some screencasts showing how to use CVAT.

<!--lint disable maximum-line-length-->

[Computer Vision Annotation Course](https://www.youtube.com/playlist?list=PL0to7Ng4PuuYQT4eXlHb_oIlq_RPeuasN):
we introduce our course series designed to help you annotate data faster and better
using CVAT. This course is about CVAT deployment and integrations, it includes
presentations and covers the following topics:

- **Speeding up your data annotation process: introduction to CVAT and Datumaro**.
  What problems do CVAT and Datumaro solve, and how they can speed up your model
  training process. Some resources you can use to learn more about how to use them.
- **Deployment and use CVAT**. Use the app online at [app.cvat.ai](https://app.cvat.ai).
  A local deployment. A containerized local deployment with Docker Compose (for regular use),
  and a local cluster deployment with Kubernetes (for enterprise users). A 2-minute
  tour of the interface, a breakdown of CVAT’s internals, and a demonstration of how
  to deploy CVAT using Docker Compose.

[Product tour](https://www.youtube.com/playlist?list=PL0to7Ng4Puua37NJVMIShl_pzqJTigFzg): in this course, we show how to use CVAT, and help to get familiar with CVAT functionality and interfaces. This course does not cover integrations and is dedicated solely to CVAT. It covers the following topics:

- **Pipeline**. In this video, we show how to use [app.cvat.ai](https://app.cvat.ai): how to sign up, upload your data, annotate it, and download it.

<!--lint enable maximum-line-length-->

For feedback, please see [Contact us](#contact-us)

## API

- [Documentation](https://docs.cvat.ai/docs/api_sdk/api/)

## SDK

- Install with `pip install cvat-sdk`
- [PyPI package homepage](https://pypi.org/project/cvat-sdk/)
- [Documentation](https://docs.cvat.ai/docs/api_sdk/sdk/)

## CLI

- Install with `pip install cvat-cli`
- [PyPI package homepage](https://pypi.org/project/cvat-cli/)
- [Documentation](https://docs.cvat.ai/docs/api_sdk/cli/)

## Supported annotation formats

CVAT supports multiple annotation formats. You can select the format
after clicking the **Upload annotation** and **Dump annotation** buttons.
[Datumaro](https://github.com/cvat-ai/datumaro) dataset framework allows
additional dataset transformations with its command line tool and Python library.

For more information about the supported formats, see:
[Annotation Formats](https://docs.cvat.ai/docs/manual/advanced/formats/).

<!--lint disable maximum-line-length-->

| Annotation format                                                                                | Import | Export |
| ------------------------------------------------------------------------------------------------ | ------ | ------ |
| [CVAT for images](https://docs.cvat.ai/docs/manual/advanced/xml_format/#annotation)              | ✔️     | ✔️     |
| [CVAT for a video](https://docs.cvat.ai/docs/manual/advanced/xml_format/#interpolation)          | ✔️     | ✔️     |
| [Datumaro](https://github.com/cvat-ai/datumaro)                                                  | ✔️     | ✔️     |
| [PASCAL VOC](http://host.robots.ox.ac.uk/pascal/VOC/)                                            | ✔️     | ✔️     |
| Segmentation masks from [PASCAL VOC](http://host.robots.ox.ac.uk/pascal/VOC/)                    | ✔️     | ✔️     |
| [YOLO](https://pjreddie.com/darknet/yolo/)                                                       | ✔️     | ✔️     |
| [MS COCO Object Detection](http://cocodataset.org/#format-data)                                  | ✔️     | ✔️     |
| [MS COCO Keypoints Detection](http://cocodataset.org/#format-data)                               | ✔️     | ✔️     |
| [MOT](https://motchallenge.net/)                                                                 | ✔️     | ✔️     |
| [MOTS PNG](https://www.vision.rwth-aachen.de/page/mots)                                          | ✔️     | ✔️     |
| [LabelMe 3.0](http://labelme.csail.mit.edu/Release3.0)                                           | ✔️     | ✔️     |
| [ImageNet](http://www.image-net.org)                                                             | ✔️     | ✔️     |
| [CamVid](http://mi.eng.cam.ac.uk/research/projects/VideoRec/CamVid/)                             | ✔️     | ✔️     |
| [WIDER Face](http://shuoyang1213.me/WIDERFACE/)                                                  | ✔️     | ✔️     |
| [VGGFace2](https://github.com/ox-vgg/vgg_face2)                                                  | ✔️     | ✔️     |
| [Market-1501](https://www.aitribune.com/dataset/2018051063)                                      | ✔️     | ✔️     |
| [ICDAR13/15](https://rrc.cvc.uab.es/?ch=2)                                                       | ✔️     | ✔️     |
| [Open Images V6](https://storage.googleapis.com/openimages/web/index.html)                       | ✔️     | ✔️     |
| [Cityscapes](https://www.cityscapes-dataset.com/login/)                                          | ✔️     | ✔️     |
| [KITTI](http://www.cvlibs.net/datasets/kitti/)                                                   | ✔️     | ✔️     |
| [Kitti Raw Format](https://www.cvlibs.net/datasets/kitti/raw_data.php)                           | ✔️     | ✔️     |
| [LFW](http://vis-www.cs.umass.edu/lfw/)                                                          | ✔️     | ✔️     |
| [Supervisely Point Cloud Format](https://docs.supervise.ly/data-organization/00_ann_format_navi) | ✔️     | ✔️     |
| [Ultralytics YOLO Detection](https://docs.ultralytics.com/datasets/detect/)                      | ✔️     | ✔️     |
| [Ultralytics YOLO Oriented Bounding Boxes](https://docs.ultralytics.com/datasets/obb/)           | ✔️     | ✔️     |
| [Ultralytics YOLO Segmentation](https://docs.ultralytics.com/datasets/segment/)                  | ✔️     | ✔️     |
| [Ultralytics YOLO Pose](https://docs.ultralytics.com/datasets/pose/)                             | ✔️     | ✔️     |
| [Ultralytics YOLO Classification](https://docs.ultralytics.com/datasets/classify/)               | ✔️     | ✔️     |

<!--lint enable maximum-line-length-->

## Deep learning serverless functions for automatic labeling

CVAT supports automatic labeling. It can speed up the annotation process
up to 10x. Here is a list of the algorithms we support, and the platforms they can be run on:

<!--lint disable maximum-line-length-->

| Name                                                                                                    | Type       | Framework  | CPU | GPU |
| ------------------------------------------------------------------------------------------------------- | ---------- | ---------- | --- | --- |
| [Segment Anything](/serverless/pytorch/facebookresearch/sam/nuclio/)                                    | interactor | PyTorch    | ✔️  | ✔️  |
| [Deep Extreme Cut](/serverless/openvino/dextr/nuclio)                                                   | interactor | OpenVINO   | ✔️  |     |
| [Faster RCNN](/serverless/openvino/omz/public/faster_rcnn_inception_resnet_v2_atrous_coco/nuclio)       | detector   | OpenVINO   | ✔️  |     |
| [Mask RCNN](/serverless/openvino/omz/public/mask_rcnn_inception_resnet_v2_atrous_coco/nuclio)           | detector   | OpenVINO   | ✔️  |     |
| [YOLO v3](/serverless/openvino/omz/public/yolo-v3-tf/nuclio)                                            | detector   | OpenVINO   | ✔️  |     |
| [YOLO v7](/serverless/onnx/WongKinYiu/yolov7/nuclio)                                                    | detector   | ONNX       | ✔️  | ✔️  |
| [Object reidentification](/serverless/openvino/omz/intel/person-reidentification-retail-0277/nuclio)    | reid       | OpenVINO   | ✔️  |     |
| [Semantic segmentation for ADAS](/serverless/openvino/omz/intel/semantic-segmentation-adas-0001/nuclio) | detector   | OpenVINO   | ✔️  |     |
| [Text detection v4](/serverless/openvino/omz/intel/text-detection-0004/nuclio)                          | detector   | OpenVINO   | ✔️  |     |
| [SiamMask](/serverless/pytorch/foolwood/siammask/nuclio)                                                | tracker    | PyTorch    | ✔️  | ✔️  |
| [TransT](/serverless/pytorch/dschoerk/transt/nuclio)                                                    | tracker    | PyTorch    | ✔️  | ✔️  |
| [Inside-Outside Guidance](/serverless/pytorch/shiyinzhang/iog/nuclio)                                   | interactor | PyTorch    | ✔️  |     |
| [Faster RCNN](/serverless/tensorflow/faster_rcnn_inception_v2_coco/nuclio)                              | detector   | TensorFlow | ✔️  | ✔️  |
| [RetinaNet](serverless/pytorch/facebookresearch/detectron2/retinanet_r101/nuclio)                       | detector   | PyTorch    | ✔️  | ✔️  |
| [Face Detection](/serverless/openvino/omz/intel/face-detection-0205/nuclio)                             | detector   | OpenVINO   | ✔️  |     |

<!--lint enable maximum-line-length-->

## License

The code is released under the [MIT License](https://opensource.org/licenses/MIT).

The code contained within the `/serverless` directory is released under the **MIT License**.
However, it may download and utilize various assets, such as source code, architectures, and weights, among others.
These assets may be distributed under different licenses, including non-commercial licenses.
It is your responsibility to ensure compliance with the terms of these licenses before using the assets.

This software uses LGPL-licensed libraries from the [FFmpeg](https://www.ffmpeg.org) project.
The exact steps on how FFmpeg was configured and compiled can be found in the [Dockerfile](Dockerfile).

FFmpeg is an open-source framework licensed under LGPL and GPL.
See [https://www.ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html). You are solely responsible
for determining if your use of FFmpeg requires any
additional licenses. CVAT.ai Corporation is not responsible for obtaining any
such licenses, nor liable for any licensing fees due in
connection with your use of FFmpeg.

## Contact us

[Gitter](https://gitter.im/opencv-cvat/public) to ask CVAT usage-related questions.
Typically questions get answered fast by the core team or community. There you can also browse other common questions.

[Discord](https://discord.gg/S6sRHhuQ7K) is the place to also ask questions or discuss any other stuff related to CVAT.

[LinkedIn](https://www.linkedin.com/company/cvat-ai/) for the company and work-related questions.

[YouTube](https://www.youtube.com/@cvat-ai) to see screencast and tutorials about the CVAT.

[GitHub issues](https://github.com/cvat-ai/cvat/issues) for feature requests or bug reports.
If it's a bug, please add the steps to reproduce it.

[#cvat](https://stackoverflow.com/search?q=%23cvat) tag on StackOverflow is one more way to ask
questions and get our support.

[Use our website](https://www.cvat.ai/contact-us/enterprise) to reach out to us if you need commercial support.

## Links

- [Intel AI blog: New Computer Vision Tool Accelerates Annotation of Digital Images and Video](https://www.intel.ai/introducing-cvat)
- [Intel Software: Computer Vision Annotation Tool: A Universal Approach to Data Annotation](https://software.intel.com/en-us/articles/computer-vision-annotation-tool-a-universal-approach-to-data-annotation)
- [VentureBeat: Intel open-sources CVAT, a toolkit for data labeling](https://venturebeat.com/2019/03/05/intel-open-sources-cvat-a-toolkit-for-data-labeling/)
- [How to Use CVAT (Roboflow guide)](https://blog.roboflow.com/cvat/)
- [How to auto-label data in CVAT with one of 50,000+ models on Roboflow Universe](https://blog.roboflow.com/how-to-use-roboflow-models-in-cvat/)

  <!-- Badges -->

[docker-server-pulls-img]: https://img.shields.io/docker/pulls/cvat/server.svg?style=flat-square&label=server%20pulls
[docker-server-image-url]: https://hub.docker.com/r/cvat/server
[docker-ui-pulls-img]: https://img.shields.io/docker/pulls/cvat/ui.svg?style=flat-square&label=UI%20pulls
[docker-ui-image-url]: https://hub.docker.com/r/cvat/ui
[ci-img]: https://github.com/cvat-ai/cvat/actions/workflows/main.yml/badge.svg?branch=develop
[ci-url]: https://github.com/cvat-ai/cvat/actions
[gitter-img]: https://img.shields.io/gitter/room/opencv-cvat/public?style=flat
[gitter-url]: https://gitter.im/opencv-cvat/public
[coverage-img]: https://codecov.io/github/cvat-ai/cvat/branch/develop/graph/badge.svg
[coverage-url]: https://codecov.io/github/cvat-ai/cvat
[doi-img]: https://zenodo.org/badge/139156354.svg
[doi-url]: https://zenodo.org/badge/latestdoi/139156354
[discord-img]: https://img.shields.io/discord/1000789942802337834?label=discord
[discord-url]: https://discord.gg/fNR3eXfk6C
[status-img]: https://uptime.betterstack.com/status-badges/v2/monitor/1yl3h.svg
[status-url]: https://status.cvat.ai
